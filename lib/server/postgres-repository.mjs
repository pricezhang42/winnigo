import { EVENT_SOURCES } from '../../config/sources.mjs';
import { availabilityOn } from '../event-schedule.mjs';
import { accessClause } from './access.mjs';
import { database, writeTransaction } from './postgres.mjs';
import { resolveMapLocation, collectionLabel } from '../location-resolution.mjs';
import { listingDedupeKey, localDay, weekendRange } from '../connectors.mjs';

const SOCIAL_SOURCES = ['facebook', 'instagram'];

// Child tables rebuilt from the listing document on every write.
const LISTING_CHILD_TABLES = ['locations', 'trail_variants', 'listing_media', 'comment_notes'];

// Photos already stored by Winnigo; only these can be attached to a listing.
const STORED_PHOTO_URL = /^\/api\/photos\/[a-f0-9]{64}$/;

// The source JSON contract is reconstructed by a view; these fields are stored only in columns.
const LISTING_COLUMNS = {
  title: 'title',
  description: 'description',
  type: 'listing_type',
  category: 'category',
  venue: 'venue',
  address: 'address',
  neighbourhood: 'neighbourhood',
  url: 'source_url',
  price: 'price',
  family: 'family',
  indoor: 'indoor',
  status: 'status',
  start: 'start_date',
  end: 'end_date',
  schedule: 'schedule_kind',
};

// Fields a collector may not send: they belonged to parser-built event listings (docs/30).
const EVENT_ONLY_FIELDS = ['occurrences', 'scheduleCoverage', 'endMonth', 'recurring'];

// Raw listing rows joined with their editorial overrides.
const LISTING_ROWS_SQL = `
  SELECT l.id, l.source, l.payload, l.hidden, coalesce(o.fields, '{}') AS override
  FROM listing_source_records l
  LEFT JOIN listing_overrides o ON o.listing_id = l.id`;

// Hides hidden, cancelled and already-finished listings and events from non-admin readers.
// `todayParam` is the bound placeholder for today's Winnipeg date.
const currentListingSql = (todayParam) => `
  NOT hidden
  AND coalesce(status, 'active') NOT IN ('hidden', 'cancelled', 'gone')
  AND coalesce(end_date, DATE '9999-12-31') >= ${todayParam}::date`;

const UPSERT_SOURCE_REPORT_SQL = `
  INSERT INTO sources VALUES ($1, $2)
  ON CONFLICT (id) DO UPDATE SET report = excluded.report`;

// Merges fields into a source report, creating the row if needed.
const MERGE_SOURCE_REPORT_SQL = `
  INSERT INTO sources VALUES ($1, $2)
  ON CONFLICT (id) DO UPDATE SET report = sources.report || excluded.report`;

/** JSON with object keys sorted, so jsonb's key reordering doesn't count as a change. */
function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + stableJson(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

/** Source content without the per-run check time, for change detection. */
const contentOf = (payload) => stableJson({ ...payload, checkedAt: undefined });

const TAB_TYPES = { Events: 'Event', Places: 'Place', Activities: 'Activity' };

/** Route length buckets: short ≤ 5 km, medium 5–15 km, anything else > 15 km. */
function distanceSql(distance) {
  const km = `(document->>'distanceKm')::numeric`;
  if (distance === 'short') return `${km} <= 5`;
  if (distance === 'medium') return `${km} > 5 AND ${km} <= 15`;
  return `${km} > 15`;
}

/**
 * Collects positional SQL parameters. `bind(value)` stores the value and returns
 * its `$n` placeholder, so clauses can be assembled in any order.
 */
function parameterList(initial = []) {
  const values = [...initial];
  const bind = (value) => {
    values.push(value);
    return '$' + values.length;
  };
  return { values, bind };
}

/** Normalises a social post URL so tracking parameters and host spelling don't create duplicates. */
export function canonical(url) {
  const parsed = new URL(url);
  if (parsed.hostname === 'www.facebook.com') parsed.hostname = 'facebook.com';
  for (const key of [...parsed.searchParams.keys()])
    if (!['story_fbid', 'id', 'fbid'].includes(key)) parsed.searchParams.delete(key);
  parsed.searchParams.sort();
  parsed.hash = '';
  return parsed.href;
}

/** The searchable document: source payload with owner overrides applied and derived fields added. */
export function documentFor(record) {
  const item = {
    ...record.payload,
    ...record.override,
    id: record.id,
    status: record.hidden ? 'hidden' : record.payload.status,
  };
  return { ...item, collection: collectionLabel(item), mapLocation: resolveMapLocation(item) };
}

function visibilityFor(record) {
  const restricted =
    SOCIAL_SOURCES.includes(record.source) || record.payload.sourceVisibility === 'private';
  return restricted ? 'restricted' : 'public';
}

/** Trails, places and community highlights, with owner edits applied (one row per listing). */
function projectedListingsSql() {
  return `SELECT l.id, 'listing'::text AS kind, l.source, l.visibility,
    l.effective_title AS title, l.effective_venue AS venue, l.effective_category AS category,
    l.effective_neighbourhood AS neighbourhood, l.effective_type AS listing_type,
    l.effective_price AS price, l.effective_family AS family, l.effective_indoor AS indoor,
    l.effective_start_date AS start_date, l.effective_end_date AS end_date,
    l.effective_status AS status, l.document->>'collection' AS collection, l.hidden,
    l.dedupe_key, l.document
    FROM listing_records l`;
}

const EVENT_SOURCE_NAMES = JSON.stringify(
  Object.fromEntries(EVENT_SOURCES.map((s) => [s.id, s.name])),
);
const isoSql = (column) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * Collected events (docs/30), projected into the same columns and listing document as
 * `projectedListingsSql`, with owner edits applied. One row per event: discovery shows its next
 * session and lists every session in `occurrences`. Readers other than admins see only events
 * with a session that has not ended.
 */
function projectedEventsSql(bind, admin = false) {
  const today = bind(localDay());
  const names = bind(EVENT_SOURCE_NAMES);
  const edit = (field) => `coalesce(e.owner_edits->>'${field}', e.${field})`;
  const sessionJson = `jsonb_strip_nulls(jsonb_build_object('id',s.id,'start',s.start_date,
    'end',s.end_date,'startAt',${isoSql('s.start_at')},'endAt',${isoSql('s.end_at')},'time','',
    'timeZone','America/Winnipeg','url',e.event_url,
    'status',CASE WHEN s.cancelled THEN 'cancelled' ELSE 'active' END))`;
  return `SELECT e.id, 'event'::text AS kind, e.source, e.visibility,
    t.title, t.venue, t.category, ''::text AS neighbourhood, 'Event'::text AS listing_type,
    t.price, false AS family, false AS indoor,
    coalesce(n.start_date, r.first_date) AS start_date, r.end_date,
    CASE WHEN e.hidden THEN 'hidden' ELSE t.status END AS status, ''::text AS collection,
    e.hidden, 'event|' || e.id AS dedupe_key,
    jsonb_strip_nulls(jsonb_build_object(
      'id',e.id,'source',e.source,'sourceName',coalesce(${names}::jsonb->>e.source,e.source),
      'title',t.title,'type','Event','category',t.category,'venue',coalesce(t.venue,''),
      'address',coalesce(t.address,''),'neighbourhood','','description',t.description,
      'url',e.event_url,'eventUrl',e.event_url,'image','','time','',
      'start',coalesce(n.start_date, r.first_date),'end',coalesce(n.end_date, r.end_date),
      'startAt',${isoSql('n.start_at')},'endAt',${isoSql('n.end_at')},
      'recurring',r.sessions > 1,'schedule','event','price',t.price,'family',false,'indoor',false,
      'admission',t.price_text,'availability',e.availability,'ticketUrl',t.ticket_url,
      'officialUrl',e.organizer_url,'checkedAt',${isoSql('e.checked_at')},
      'status',CASE WHEN e.hidden THEN 'hidden' ELSE t.status END,'provenance','ai-extraction',
      'occurrences',(SELECT coalesce(jsonb_agg(${sessionJson} ORDER BY s.start_date,s.start_at),'[]')
        FROM event_sessions s WHERE s.event_id=e.id ${admin ? '' : `AND s.end_date >= ${today}::date`})
      ${admin ? `,'reviewNotes',e.review_notes,'ownerEdits',e.owner_edits` : ''}
    )) || jsonb_build_object('price', t.price) AS document
    FROM events e
    CROSS JOIN LATERAL (SELECT ${edit('title')} AS title, ${edit('venue')} AS venue,
      ${edit('address')} AS address, ${edit('category')} AS category,
      ${edit('description')} AS description, ${edit('price_text')} AS price_text,
      ${edit('ticket_url')} AS ticket_url, ${edit('status')} AS status,
      CASE WHEN e.owner_edits ? 'price' THEN nullif(e.owner_edits->>'price','')::numeric
        ELSE e.price END AS price) t
    LEFT JOIN LATERAL (SELECT s.start_date, s.end_date, s.start_at, s.end_at FROM event_sessions s
      WHERE s.event_id=e.id AND NOT s.cancelled AND s.end_date >= ${today}::date
      ORDER BY s.start_date, s.start_at NULLS FIRST LIMIT 1) n ON true
    LEFT JOIN LATERAL (SELECT min(s.start_date) AS first_date, max(s.end_date) AS end_date,
      count(*)::int AS sessions FROM event_sessions s WHERE s.event_id=e.id AND NOT s.cancelled) r ON true
    ${admin ? '' : 'WHERE n.start_date IS NOT NULL'}`;
}

/** Everything discovery reads: listings (trails, places, community) and collected events. */
function discoverySql(bind, admin = false) {
  return `${projectedListingsSql()} UNION ALL ${projectedEventsSql(bind, admin)}`;
}

/** Builds the WHERE clauses for a discovery search. Access control is always the first clause. */
function searchClauses(filters, bind) {
  const doc = 'document';
  const clauses = [accessClause(filters.principal, bind, 'listings')];
  if (!filters.admin) clauses.push(currentListingSql(bind(localDay())).trim());

  if (filters.query) {
    const sourceName = `${doc}->>'sourceName'`;
    const searchable = `concat_ws(' ', title, venue, category, ${sourceName})`;
    clauses.push(`strpos(lower(${searchable}), lower(${bind(filters.query)})) > 0`);
  }
  if (filters.collection && filters.collection !== 'All discoveries')
    clauses.push(`collection = ${bind(filters.collection)}`);
  if (filters.category && filters.category !== 'All') {
    const outdoors = filters.category === 'Outdoors' ? `OR category IN ('Hiking', 'Cycling')` : '';
    clauses.push(
      `(category = ${bind(filters.category)} OR coalesce(${doc}->'activityCategories', '[]') ? ${bind(filters.category)} ${outdoors})`,
    );
  }
  if (filters.area && filters.area !== 'All neighbourhoods')
    clauses.push(`neighbourhood = ${bind(filters.area)}`);

  const type = TAB_TYPES[filters.tab];
  if (type) clauses.push(`listing_type = ${bind(type)}`);
  if (filters.tab === 'Saved') clauses.push(`id = ANY(${bind(filters.ids || [])}::text[])`);
  if (filters.tab === 'Trail map')
    clauses.push(`(source = 'trails-manitoba' OR category IN ('Hiking', 'Cycling'))`);

  if (filters.quick === 'Free') clauses.push('price = 0');
  if (filters.quick === 'Family-friendly') clauses.push('family IS TRUE');
  if (filters.quick === 'Indoors') clauses.push('indoor IS TRUE');
  if (filters.date || ['Today', 'This weekend'].includes(filters.quick)) {
    const today = localDay();
    const { first, last } = filters.date
      ? { first: filters.date, last: filters.date }
      : filters.quick === 'This weekend'
        ? weekendRange(today)
        : { first: today, last: today };
    // An event matches one of its sessions, never the gap between them; a dated listing (a
    // community outing) matches its own dates; undated listings never match a date.
    const [to, from] = [bind(last), bind(first)];
    clauses.push(`(CASE WHEN kind = 'event' THEN EXISTS(SELECT 1 FROM event_sessions es
      WHERE es.event_id=listings.id AND NOT es.cancelled AND es.start_date<=${to}
      AND es.end_date>=${from})
      ELSE start_date<=${to} AND coalesce(end_date,start_date)>=${from} END)`);
  }

  if (filters.season && filters.season !== 'Any')
    clauses.push(`coalesce(${doc}->'seasons', '[]') ? ${bind(filters.season)}`);
  if (filters.difficulty && filters.difficulty !== 'Any')
    clauses.push(`coalesce(${doc}->>'difficulty', 'Unknown') = ${bind(filters.difficulty)}`);
  if (filters.distance && filters.distance !== 'Any') clauses.push(distanceSql(filters.distance));
  return clauses;
}

/** Validates a listing payload: event-only fields belong to collected events (docs/30). */
function listingPayload(record) {
  const item = { ...record.payload };
  for (const field of EVENT_ONLY_FIELDS) delete item[field];
  if (record.id !== item.id || record.source !== item.source || !item.title || !item.url)
    throw Error('Invalid listing identity');
  for (const field of ['start', 'end'])
    if (item[field] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(item[field]))
      throw Error('Invalid listing date');
  return item;
}

export class PostgresRepository {
  constructor(pool = database()) {
    this.pool = pool;
  }

  async health() {
    await this.pool.query('SELECT 1 FROM listings LIMIT 1');
    return true;
  }

  /** Every listing and source report (seeding and checks). */
  async read() {
    const [listings, sources] = await Promise.all([
      this.pool.query(LISTING_ROWS_SQL),
      this.pool.query('SELECT report FROM sources'),
    ]);
    return { listings: listings.rows, sources: sources.rows.map((row) => row.report) };
  }

  /** Whether `id` is a collected event (edited through event-store, not listing overrides). */
  async isEvent(id) {
    return (await this.pool.query('SELECT 1 FROM events WHERE id=$1', [id])).rowCount > 0;
  }

  /**
   * Upserts one listing and rebuilds its child rows inside the caller's transaction.
   * With `preserveEditorial`, an existing listing keeps its hidden flag and owner overrides.
   */
  async writeRecord(client, record, { preserveEditorial = false } = {}) {
    const item = listingPayload(record);
    record = { ...record, payload: item };

    await client.query('INSERT INTO sources(id,report) VALUES($1,$2) ON CONFLICT DO NOTHING', [
      record.source,
      { id: record.source, status: 'pending', count: 0, checkedAt: '' },
    ]);

    const previous = (await client.query(LISTING_ROWS_SQL + ' WHERE l.id = $1', [record.id]))
      .rows[0];
    if (previous && previous.source !== record.source)
      throw Error('A stable listing ID cannot change source');
    if (preserveEditorial && previous)
      record = { ...record, hidden: previous.hidden, override: previous.override };

    const doc = documentFor(record);
    const sourceFields = Object.keys(LISTING_COLUMNS).filter((key) => item[key] !== undefined);
    const metadata = Object.fromEntries(
      Object.entries(item).filter(
        ([key]) => !['id', 'source'].includes(key) && !Object.hasOwn(LISTING_COLUMNS, key),
      ),
    );
    const columns = [
      'id',
      'source',
      'hidden',
      'visibility',
      'dedupe_key',
      'source_fields',
      'metadata',
      ...Object.values(LISTING_COLUMNS),
    ];
    const values = [
      record.id,
      record.source,
      !!record.hidden,
      visibilityFor(record),
      listingDedupeKey(doc),
      sourceFields,
      metadata,
      ...Object.keys(LISTING_COLUMNS).map((key) => item[key] ?? null),
    ];
    await client.query(
      `INSERT INTO listings(${columns.join(',')}) VALUES(${values.map((_, i) => '$' + (i + 1)).join(',')})
       ON CONFLICT(id) DO UPDATE SET ${columns
         .slice(2)
         .map((column) => `${column}=excluded.${column}`)
         .join(',')},updated_at=now()`,
      values,
    );
    await client.query(
      'INSERT INTO listing_overrides VALUES ($1, $2) ON CONFLICT (listing_id) DO UPDATE SET fields = excluded.fields',
      [record.id, record.override || {}],
    );
    await this.replaceChildRows(client, record.id, doc);
  }

  async replaceChildRows(client, listingId, doc) {
    for (const table of LISTING_CHILD_TABLES)
      await client.query(`DELETE FROM ${table} WHERE listing_id = $1`, [listingId]);
    if (doc.mapLocation)
      await client.query('INSERT INTO locations VALUES ($1, $2)', [listingId, doc.mapLocation]);
    for (const [position, variant] of (doc.trailVariants || []).entries())
      await client.query('INSERT INTO trail_variants VALUES ($1, $2, $3)', [
        listingId,
        position,
        variant,
      ]);

    // External image URLs are ignored; a stored photo must have finished uploading.
    const allImages = [...(doc.images || []), ...(doc.image ? [doc.image] : [])];
    const photoUrls = [...new Set(allImages)].filter((url) => STORED_PHOTO_URL.test(url));
    for (const [position, url] of photoUrls.entries()) {
      const mediaId = url.split('/').pop();
      const media = await client.query("SELECT 1 FROM media WHERE id = $1 AND status = 'ready'", [
        mediaId,
      ]);
      if (!media.rowCount) throw Error('Referenced photo has not completed upload');
      await client.query('INSERT INTO listing_media VALUES ($1, $2, $3)', [
        listingId,
        mediaId,
        position,
      ]);
    }

    for (const [position, note] of (doc.commentNotes || []).entries())
      await client.query('INSERT INTO comment_notes VALUES ($1, $2, $3, $4)', [
        listingId,
        position,
        note.text,
        note.url,
      ]);
  }

  /**
   * Runs `change(state)` against an in-memory copy of the listings in `scope`, then writes back
   * only the records and source reports that changed, all in one transaction.
   *
   * Scope: `{action:'update', id}` loads one listing; `{urls}` loads the social posts with those
   * URLs; `principal` restricts the loaded rows to what that user may read.
   */
  async transaction(change, scope) {
    return writeTransaction(this.pool, async (client) => {
      const params = parameterList();
      const conditions = [];
      if (scope?.action === 'update') conditions.push(`l.id = ${params.bind(scope.id)}`);
      // Social posts are matched by canonical URL (tracking parameters and host spelling
      // differ between shares), so the community rows are narrowed in memory.
      else if (scope?.urls) conditions.push(`l.source = ANY(${params.bind(SOCIAL_SOURCES)})`);
      if (scope?.principal) conditions.push(accessClause(scope.principal, params.bind, 'l'));
      const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';

      const loaded = (await client.query(LISTING_ROWS_SQL + where, params.values)).rows;
      const wanted = new Set((scope?.urls || []).map(canonical));
      const initialRows = scope?.urls
        ? loaded.filter((row) => wanted.has(canonical(row.payload.url)))
        : loaded;
      const initialReports = (await client.query('SELECT report FROM sources')).rows.map(
        (row) => row.report,
      );
      const state = {
        listings: structuredClone(initialRows),
        sources: structuredClone(initialReports),
      };
      const result = await change(state);

      const unchanged = new Map(initialRows.map((row) => [row.id, JSON.stringify(row)]));
      for (const record of state.listings) {
        if (unchanged.get(record.id) === JSON.stringify(record)) continue;
        await this.writeRecord(client, record);
        await client.query('INSERT INTO audit_records(action, listing_id) VALUES ($1, $2)', [
          scope?.action || 'upsert',
          record.id,
        ]);
      }
      for (const report of state.sources) {
        const original = initialReports.find((r) => r.id === report.id);
        if (JSON.stringify(original) !== JSON.stringify(report))
          await client.query(UPSERT_SOURCE_REPORT_SQL, [report.id, report]);
      }

      if (scope?.action === 'sync-hiking-manitoba')
        await client.query(
          'INSERT INTO collection_runs(source, status, counts) VALUES ($1, $2, $3)',
          [
            'facebook',
            result.status,
            { processed: result.processed, added: result.added, updated: result.updated },
          ],
        );
      return result;
    });
  }

  /** Bulk import used by seeding; keeps existing owner edits. */
  async importRecords(records, sources = []) {
    return writeTransaction(this.pool, async (client) => {
      for (const record of records)
        await this.writeRecord(client, record, { preserveEditorial: true });
      for (const report of sources)
        await client.query(UPSERT_SOURCE_REPORT_SQL, [report.id, report]);
    });
  }

  /**
   * Saves one successful collection of a places source in a single transaction.
   *
   * Every collected listing is written (so its check time stays current) while owner overrides and
   * hidden flags are kept. Places the source no longer lists are left alone. Returns
   * `{ counts, warning }`; `updated` means the content changed, not just the check time. Only
   * content changes are written to the audit log. A source returning less than half of its last
   * successful count (of at least ten) is flagged with a warning.
   */
  async applySourceCollection(sourceId, items, { checkedAt }) {
    return writeTransaction(this.pool, async (client) => {
      const existing = new Map(
        (await client.query(LISTING_ROWS_SQL + ' WHERE l.source = $1', [sourceId])).rows.map(
          (row) => [row.id, row],
        ),
      );
      const counts = { found: items.length, added: 0, updated: 0, unchanged: 0 };
      const previous = (await client.query('SELECT report FROM sources WHERE id = $1', [sourceId]))
        .rows[0]?.report;
      const previousCount = previous?.status === 'ok' ? Number(previous.count) || 0 : 0;
      const warning =
        previousCount >= 10 && items.length < previousCount / 2
          ? `Found ${items.length} listings, down from ${previousCount}`
          : null;
      const collected = new Set();
      for (const item of items) {
        if (item.source !== sourceId) throw Error('Collected listing belongs to another source');
        if (collected.has(item.id)) continue;
        collected.add(item.id);
        const old = existing.get(item.id);
        await this.writeRecord(client, {
          id: item.id,
          source: sourceId,
          payload: item,
          hidden: old?.hidden ?? false,
          override: old?.override ?? {},
        });
        if (
          old &&
          contentOf(old.payload) === contentOf(listingPayload({ ...old, payload: item }))
        ) {
          counts.unchanged++;
          continue;
        }
        await client.query('INSERT INTO audit_records(action, listing_id) VALUES ($1, $2)', [
          'collect',
          item.id,
        ]);
        if (old) counts.updated++;
        else counts.added++;
      }
      await client.query(MERGE_SOURCE_REPORT_SQL, [
        sourceId,
        {
          id: sourceId,
          checkedAt,
          attemptedAt: checkedAt,
          count: collected.size,
          status: 'ok',
          error: null,
        },
      ]);
      return { counts, warning };
    });
  }

  async availability(id, date, { principal } = {}) {
    const item = await this.detail(id, { admin: true, principal });
    if (!item || item.status === 'hidden') return null;
    return availabilityOn(item, date);
  }

  /** One listing or event document, or null if missing or not readable by `principal`. */
  async detail(id, { admin = false, principal } = {}) {
    const params = parameterList([id]);
    const projection = discoverySql(params.bind, admin);
    const conditions = ['id=$1', accessClause(principal, params.bind, 'listings')];
    if (!admin) conditions.push(currentListingSql(params.bind(localDay())).trim());
    const result = await this.pool.query(
      `WITH listings AS (${projection}) SELECT document FROM listings WHERE ${conditions.join(' AND ')} LIMIT 1`,
      params.values,
    );
    return result.rows[0]?.document || null;
  }

  /**
   * One page of discovery results plus totals, neighbourhood facets and source reports.
   * Non-admin results collapse duplicates by `dedupe_key` and interleave sources by rank.
   */
  async search(filters = {}) {
    const params = parameterList();
    const projection = discoverySql(params.bind, !!filters.admin);
    const clauses = searchClauses(filters, params.bind);
    const limit = Math.min(100, Math.max(1, filters.limit || 24));
    const offset = filters.offset || 0;
    const duplicateKey = filters.admin ? 'id' : 'dedupe_key';

    // One statement, so the count and the page come from the same snapshot.
    const page = await this.pool.query(
      `WITH listings AS (${projection}), filtered AS (
         SELECT *, row_number() OVER (PARTITION BY ${duplicateKey} ORDER BY id) AS duplicate
         FROM listings WHERE ${clauses.join(' AND ') || 'true'}
       ),
       unique_items AS (SELECT * FROM filtered WHERE duplicate = 1),
       ranked AS (
         SELECT *, row_number() OVER (
           PARTITION BY source
           ORDER BY coalesce(start_date, ${params.bind(localDay())}::date),
             coalesce((document->>'startAt')::timestamptz, start_date::timestamp AT TIME ZONE 'America/Winnipeg'), title, id
         ) AS source_rank
         FROM unique_items
       )
       SELECT
         (SELECT count(*)::int FROM unique_items) AS total,
         coalesce((
           SELECT jsonb_agg(document ORDER BY source_rank, source, id)
           FROM (
             SELECT * FROM ranked ORDER BY source_rank, source, id
             LIMIT ${params.bind(limit)} OFFSET ${params.bind(offset)}
           ) page
         ), '[]') AS items`,
      params.values,
    );

    // Facets and source counts ignore the current filters but still respect access.
    const facetParams = parameterList([localDay()]);
    const facetProjection = discoverySql(facetParams.bind, false);
    const visible =
      currentListingSql('$1') + ' AND ' + accessClause(filters.principal, facetParams.bind);
    const areas = await this.pool.query(
      `WITH listings AS (${facetProjection}) SELECT DISTINCT neighbourhood AS area FROM listings WHERE ${visible} ORDER BY area`,
      facetParams.values,
    );
    const reports = await this.sourceReports(
      filters.principal,
      visible,
      facetParams.values,
      facetProjection,
    );

    const { total } = page.rows[0];
    const items = page.rows[0].items.map((item) =>
      filters.date ? { ...item, visitAvailability: availabilityOn(item, filters.date) } : item,
    );
    const end = offset + items.length;
    return {
      items,
      total,
      nextOffset: end < total ? end : null,
      areas: areas.rows.map((row) => row.area).filter(Boolean),
      reports,
    };
  }

  /** The owner sees full collection reports; others only counts of listings they can read. */
  async sourceReports(principal, visibleSql, values, projection) {
    if (principal?.role === 'owner')
      return (await this.pool.query('SELECT report FROM sources ORDER BY id')).rows.map(
        (row) => row.report,
      );
    const counts = await this.pool.query(
      `WITH listings AS (${projection}) SELECT source AS id, count(*)::int AS count, max(document->>'checkedAt') AS "checkedAt"
       FROM listings WHERE ${visibleSql} GROUP BY source`,
      values,
    );
    return counts.rows.map((row) => ({ ...row, status: 'ok' }));
  }
}
