import {
  normalizeEvents,
  projectEvent,
  availabilityOn,
  collectionWindow,
} from '../event-schedule.mjs';
import { accessClause, occurrenceAccessClause } from './access.mjs';
import { database, writeTransaction } from './postgres.mjs';
import { resolveMapLocation, collectionLabel } from '../location-resolution.mjs';
import {
  isPlaceholderDescription,
  listingDedupeKey,
  localDay,
  weekendRange,
} from '../connectors.mjs';

const SOCIAL_SOURCES = ['facebook', 'instagram'];

// Child tables rebuilt from the listing document on every write.
const LISTING_CHILD_TABLES = ['locations', 'trail_variants', 'listing_media', 'comment_notes'];

// Photos already stored by Winnigo; only these can be attached to a listing.
const STORED_PHOTO_URL = /^\/api\/photos\/[a-f0-9]{64}$/;

// Reconstruct the API contract at the boundary; schedule queries use typed columns.
const occurrenceJson = (alias) => `${alias}.details || jsonb_strip_nulls(jsonb_build_object(
  'id',${alias}.occurrence_id,'start',${alias}.start_date,'end',${alias}.end_date,
  'startAt',to_char(${alias}.start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'endAt',to_char(${alias}.end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'time',${alias}.time_label,'timeZone',${alias}.time_zone,'status',${alias}.status,
  'url',${alias}.source_url,'basis',${alias}.basis))`;

// Raw listing rows joined with their editorial overrides.
const LISTING_ROWS_SQL = `
  SELECT l.id, l.source, l.payload || jsonb_build_object('occurrences',coalesce((SELECT jsonb_agg(${occurrenceJson('s')} || jsonb_build_object('hidden',s.hidden,'override',s.override) ORDER BY s.ordinal) FROM occurrences s WHERE s.listing_id=l.id),'[]'), 'scheduleCoverage',coalesce((SELECT jsonb_agg(jsonb_build_object('from',c.first_day,'to',c.last_day,'complete',c.complete,'checkedAt',c.checked_at,'sourceUrl',c.source_url,'basis',c.basis)) FROM schedule_coverage c WHERE c.listing_id=l.id),'[]')) AS payload, l.hidden, coalesce(o.fields, '{}') AS override
  FROM listings l
  LEFT JOIN listing_overrides o ON o.listing_id = l.id`;

// Hides hidden, cancelled and already-finished listings from non-admin readers.
// `todayParam` is the bound placeholder for today's Winnipeg date.
const currentListingSql = (todayParam) => `
  NOT hidden
  AND coalesce(document->>'status', 'active') NOT IN ('hidden', 'cancelled', 'superseded')
  AND coalesce(document->>'end', '9999-12-31') >= ${todayParam}
  AND coalesce(document->>'endMonth','9999-12') >= left(${todayParam},7)`;

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

// Shared URLs can publish several sessions; only copies of the same session may merge.
const sourceCopyKey = (item) =>
  JSON.stringify(
    item.recurring && !item.startAt
      ? ['event', item.id]
      : [item.url, item.startAt ? new Date(item.startAt).toISOString() : null],
  );

/** Whether the owner has hidden or corrected a listing. */
const hasEdits = (row) => row.hidden || Object.keys(row.override || {}).length > 0;

/** Source content without the per-run check time, for change detection. */
const contentOf = (payload) => {
  const { occurrences = [], scheduleCoverage = [], ...fields } = payload;
  return stableJson({
    ...fields,
    checkedAt: undefined,
    occurrences: occurrences
      .map(({ hidden, override, ...o }) => o)
      .sort((a, b) => a.id.localeCompare(b.id)),
    scheduleCoverage: scheduleCoverage.map(({ checkedAt, ...c }) => c),
  });
};

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

/** The key that identifies a record within its source: the post URL for social posts, else the ID. */
export function identity(record) {
  return SOCIAL_SOURCES.includes(record.source) ? canonical(record.payload.url) : record.id;
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

/** SQL projections keep pagination bounded while event details are stored only once. */
function projectedListingsSql(principal, bind, admin = false) {
  const readable = occurrenceAccessClause(principal, bind, 'l', 's');
  const children = `coalesce((SELECT jsonb_agg(${occurrenceJson('s')} || jsonb_build_object('id',s.occurrence_id,'hidden',s.hidden,'override',s.override) ORDER BY s.start_date,s.ordinal)
    FROM occurrences s WHERE s.listing_id=l.id AND ${readable} ${admin ? '' : 'AND NOT s.hidden'}),'[]')`;
  const coverage = `coalesce((SELECT jsonb_agg(jsonb_build_object('from',c.first_day,'to',c.last_day,'complete',c.complete,'checkedAt',c.checked_at,'sourceUrl',c.source_url,'basis',c.basis)) FROM schedule_coverage c WHERE c.listing_id=l.id),'[]')`;
  const eventReadable = accessClause(principal, bind, 'l', 'id', false);
  const base = `l.document || jsonb_build_object('occurrences',${children},'scheduleCoverage',CASE WHEN ${eventReadable} THEN ${coverage} ELSE '[]'::jsonb END)`;
  return `SELECT coalesce(o.occurrence_id,l.id) AS id,l.id AS event_id,o.occurrence_id,l.source,l.visibility,
    l.hidden OR coalesce(o.hidden,false) AS hidden,
    CASE WHEN o.occurrence_id IS NULL THEN l.dedupe_key ELSE l.source || '|' || o.occurrence_id END AS dedupe_key,
    CASE WHEN o.occurrence_id IS NULL THEN ${base} ELSE ${base} || ${occurrenceJson('o')} || o.override ||
      jsonb_build_object('id',o.occurrence_id,'eventId',l.id,'occurrenceId',o.occurrence_id,'recurring',true,'schedule','event',
        'status',CASE WHEN l.document->>'status'='cancelled' THEN 'cancelled' WHEN o.hidden THEN 'hidden' ELSE o.status END) END AS document
    FROM listings l LEFT JOIN LATERAL(SELECT s.* FROM occurrences s WHERE s.listing_id=l.id AND ${readable}
      AND l.document->>'recurring'='true' AND l.document->>'type'<>'Place' AND ${admin ? 'false' : 'true'}) o ON true`;
}

/** Builds the WHERE clauses for a discovery search. Access control is always the first clause. */
function searchClauses(filters, bind) {
  const doc = 'document';
  const clauses = [accessClause(filters.principal, bind, 'listings', 'event_id')];
  if (!filters.admin) clauses.push(currentListingSql(bind(localDay())).trim());

  if (filters.query) {
    const sourceName = filters.admin ? `${doc}->>'sourceName'` : "''";
    const searchable = `concat_ws(' ', ${doc}->>'title', ${doc}->>'venue', ${doc}->>'category', ${sourceName})`;
    clauses.push(`strpos(lower(${searchable}), lower(${bind(filters.query)})) > 0`);
  }
  if (filters.collection && filters.collection !== 'All discoveries')
    clauses.push(`${doc}->>'collection' = ${bind(filters.collection)}`);
  if (filters.category && filters.category !== 'All') {
    const outdoors =
      filters.category === 'Outdoors' ? `OR ${doc}->>'category' IN ('Hiking', 'Cycling')` : '';
    clauses.push(
      `(${doc}->>'category' = ${bind(filters.category)} OR coalesce(${doc}->'activityCategories', '[]') ? ${bind(filters.category)} ${outdoors})`,
    );
  }
  if (filters.area && filters.area !== 'All neighbourhoods')
    clauses.push(`${doc}->>'neighbourhood' = ${bind(filters.area)}`);

  const type = TAB_TYPES[filters.tab];
  if (type) clauses.push(`${doc}->>'type' = ${bind(type)}`);
  if (filters.tab === 'Saved') clauses.push(`id = ANY(${bind(filters.ids || [])}::text[])`);
  if (filters.tab === 'Trail map')
    clauses.push(`(source = 'trails-manitoba' OR ${doc}->>'category' IN ('Hiking', 'Cycling'))`);

  if (filters.quick === 'Free') clauses.push(`${doc}->'price' = '0'::jsonb`);
  if (filters.quick === 'Family-friendly') clauses.push(`${doc}->'family' = 'true'::jsonb`);
  if (filters.quick === 'Indoors') clauses.push(`${doc}->'indoor' = 'true'::jsonb`);
  if (filters.date || ['Today', 'This weekend'].includes(filters.quick)) {
    const today = localDay();
    const { first, last } = filters.date
      ? { first: filters.date, last: filters.date }
      : filters.quick === 'This weekend'
        ? weekendRange(today)
        : { first: today, last: today };
    // Match the linked interval, never the exhibition's overall run or a missing date.
    clauses.push(`EXISTS(SELECT 1 FROM occurrences s WHERE s.listing_id=listings.event_id
      AND (listings.occurrence_id IS NULL OR s.occurrence_id=listings.occurrence_id)
      AND NOT s.hidden AND s.status='active'
      AND s.start_date<=${bind(last)} AND s.end_date>=${bind(first)})`);
  }

  if (filters.season && filters.season !== 'Any')
    clauses.push(`coalesce(${doc}->'seasons', '[]') ? ${bind(filters.season)}`);
  if (filters.difficulty && filters.difficulty !== 'Any')
    clauses.push(`coalesce(${doc}->>'difficulty', 'Unknown') = ${bind(filters.difficulty)}`);
  if (filters.distance && filters.distance !== 'Any') clauses.push(distanceSql(filters.distance));
  return clauses;
}

export class PostgresRepository {
  constructor(pool = database()) {
    this.pool = pool;
  }

  async health() {
    await this.pool.query('SELECT 1 FROM listings LIMIT 1');
    return true;
  }

  /** Every listing and source report. Used by fixture-compatible code paths and exports. */
  async read() {
    const [listings, sources, aliases] = await Promise.all([
      this.pool.query(LISTING_ROWS_SQL),
      this.pool.query('SELECT report FROM sources'),
      this.pool.query('SELECT legacy_id,listing_id,occurrence_id FROM event_aliases'),
    ]);
    return {
      version: 1,
      aliases: Object.fromEntries(
        aliases.rows.map((row) => [
          row.legacy_id,
          { eventId: row.listing_id, occurrenceId: row.occurrence_id },
        ]),
      ),
      listings: listings.rows,
      sources: sources.rows.map((row) => row.report),
    };
  }

  /**
   * Upserts one listing and rebuilds its child rows inside the caller's transaction.
   * With `preserveEditorial`, an existing listing keeps its hidden flag and owner overrides.
   */
  async writeRecord(client, record, { preserveEditorial = false } = {}) {
    const normalized = normalizeEvents(
      [record.payload],
      record.payload.checkedAt || new Date().toISOString(),
    )[0];
    const {
      occurrences: incomingOccurrences,
      scheduleCoverage: incomingCoverage,
      ...item
    } = normalized;
    record = { ...record, payload: item };
    if (record.id !== item.id || record.source !== item.source || !item.title || !item.url)
      throw Error('Invalid listing identity');

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
    let effectiveOccurrences = incomingOccurrences,
      effectiveCoverage = incomingCoverage;
    if (doc.visitingSchedule !== undefined) {
      const effective = normalizeEvents([{ ...doc, occurrences: incomingOccurrences }])[0];
      effectiveOccurrences = effective.occurrences;
      effectiveCoverage = effective.scheduleCoverage;
    }
    const externalKey = identity(record);
    const owner = await client.query(
      'SELECT listing_id FROM source_identities WHERE source = $1 AND external_key = $2',
      [record.source, externalKey],
    );
    if (owner.rows[0] && owner.rows[0].listing_id !== record.id)
      throw Error('Source identity conflicts with a different stable listing ID');

    await client.query(
      `INSERT INTO listings(id, source, payload, document, hidden, visibility, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         payload = excluded.payload,
         document = excluded.document,
         hidden = excluded.hidden,
         visibility = excluded.visibility,
         dedupe_key = excluded.dedupe_key,
         updated_at = now()`,
      [
        record.id,
        record.source,
        item,
        doc,
        record.hidden,
        visibilityFor(record),
        listingDedupeKey(doc),
      ],
    );
    await client.query(
      'INSERT INTO source_identities(source, external_key, listing_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [record.source, externalKey, record.id],
    );
    await client.query(
      'INSERT INTO listing_overrides VALUES ($1, $2) ON CONFLICT (listing_id) DO UPDATE SET fields = excluded.fields',
      [record.id, record.override || {}],
    );
    await this.replaceChildRows(client, record.id, doc, effectiveOccurrences, effectiveCoverage);
  }

  async replaceChildRows(client, listingId, doc, incomingOccurrences = [], incomingCoverage = []) {
    for (const table of LISTING_CHILD_TABLES)
      await client.query(`DELETE FROM ${table} WHERE listing_id = $1`, [listingId]);

    if (doc.visitingSchedule !== undefined) {
      const window = collectionWindow();
      await client.query(
        "DELETE FROM schedule_coverage WHERE listing_id=$1 AND basis='hours' AND last_day>=$2 AND first_day<=$3",
        [listingId, window.from, window.to],
      );
      await client.query(
        `UPDATE occurrences SET status='superseded' WHERE listing_id=$1 AND basis='hours'
        AND start_date>=$2 AND start_date<=$3 AND NOT(occurrence_id=ANY($4::text[]))`,
        [
          listingId,
          window.from,
          window.to,
          incomingOccurrences.filter((o) => o.basis === 'hours').map((o) => o.id),
        ],
      );
    }
    for (const [ordinal, occurrence] of incomingOccurrences.entries()) {
      const { id, start, end, startAt, endAt, time, timeZone, status, url, basis, ...metadata } =
        occurrence;
      await client.query(
        `INSERT INTO occurrences(listing_id,ordinal,occurrence_id,start_date,end_date,start_at,end_at,
          time_label,time_zone,status,source_url,basis,details)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT(listing_id,occurrence_id) DO UPDATE SET
          ordinal=excluded.ordinal,start_date=excluded.start_date,end_date=excluded.end_date,
          start_at=excluded.start_at,end_at=excluded.end_at,time_label=excluded.time_label,
          time_zone=excluded.time_zone,status=excluded.status,source_url=excluded.source_url,
          basis=excluded.basis,details=excluded.details`,
        [
          listingId,
          ordinal,
          id,
          start,
          end,
          startAt || null,
          endAt || null,
          time,
          timeZone,
          status,
          url,
          basis,
          metadata,
        ],
      );
    }
    for (const coverage of incomingCoverage) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(coverage.from) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(coverage.to) ||
        coverage.to < coverage.from ||
        !Number.isFinite(Date.parse(coverage.checkedAt))
      )
        throw Error('Invalid schedule coverage');
      await client.query(
        `INSERT INTO schedule_coverage VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(listing_id,first_day,last_day) DO UPDATE SET complete=schedule_coverage.complete OR excluded.complete,
          checked_at=CASE WHEN excluded.complete THEN excluded.checked_at ELSE schedule_coverage.checked_at END,source_url=excluded.source_url`,
        [
          listingId,
          coverage.from,
          coverage.to,
          !!coverage.complete,
          coverage.checkedAt,
          coverage.sourceUrl || null,
          coverage.basis || 'calendar',
        ],
      );
    }
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
   * Scope: `{action:'update', id}` loads one listing; `{urls}` loads listings with those social
   * post URLs; `principal` restricts the loaded rows to what that user may read.
   */
  async transaction(change, scope) {
    return writeTransaction(this.pool, async (client) => {
      const params = parameterList();
      const conditions = [];
      if (scope?.action === 'update') conditions.push(`l.id = ${params.bind(scope.id)}`);
      else if (scope?.urls)
        conditions.push(
          `l.id IN (SELECT listing_id FROM source_identities WHERE external_key = ANY(${params.bind(scope.urls.map(canonical))}::text[]))`,
        );
      if (scope?.principal) conditions.push(accessClause(scope.principal, params.bind, 'l'));
      const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';

      const initialRows = (await client.query(LISTING_ROWS_SQL + where, params.values)).rows;
      const initialReports = (await client.query('SELECT report FROM sources')).rows.map(
        (row) => row.report,
      );
      const state = {
        version: 1,
        aliases: Object.fromEntries(
          (
            await client.query('SELECT legacy_id,listing_id,occurrence_id FROM event_aliases')
          ).rows.map((row) => [
            row.legacy_id,
            { eventId: row.listing_id, occurrenceId: row.occurrence_id },
          ]),
        ),
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

  /** Bulk import used by seeding and legacy migration; keeps existing owner edits. */
  async importRecords(records, sources = []) {
    return writeTransaction(this.pool, async (client) => {
      for (const record of records)
        await this.writeRecord(client, record, { preserveEditorial: true });
      for (const report of sources)
        await client.query(UPSERT_SOURCE_REPORT_SQL, [report.id, report]);
    });
  }

  /**
   * Saves one successful collection of a public source in a single transaction.
   *
   * Every collected listing is written (so its check time stays current) while owner overrides and
   * hidden flags are kept. With `cancelMissing`, listings the source no longer publishes are
   * marked cancelled, never deleted. Returns `{ counts, warning }`; `updated` means the content
   * changed, not just the check time. Only content changes are written to the audit log.
   *
   * Drop guard: when a source returns less than half of its last successful count (of at least
   * ten), the run is flagged with a warning and, for `cancelMissing` sources, nothing is cancelled,
   * because a half-broken parse must not cancel real sessions. An incomplete read
   * (`complete: false`) keeps the previous count as the baseline for this guard.
   *
   * Copies: rows of this source with the same page URL and occurrence start but another ID (left by the earlier
   * date-based IDs) are merged and deleted. Edits come from the current ID if it has any, else from
   * the newest copy; access grants and history move to the surviving ID (counted as `merged`).
   */
  async applySourceCollection(
    sourceId,
    items,
    {
      checkedAt,
      cancelMissing = false,
      complete = true,
      supersededUrls = [],
      supersededIds = [],
      preserveHistory = false,
    },
  ) {
    items = normalizeEvents(items, checkedAt, { bounded: !preserveHistory });
    return writeTransaction(this.pool, async (client) => {
      const existing = new Map(
        (await client.query(LISTING_ROWS_SQL + ' WHERE l.source = $1', [sourceId])).rows.map(
          (row) => [row.id, row],
        ),
      );
      const counts = {
        found: items.length,
        added: 0,
        updated: 0,
        unchanged: 0,
        cancelled: 0,
        merged: 0,
      };
      const updatedAt = new Map(
        (
          await client.query('SELECT id, updated_at FROM listings WHERE source = $1', [sourceId])
        ).rows.map((row) => [row.id, row.updated_at.getTime()]),
      );
      // Same-URL/session rows, newest first.
      const byUrl = new Map();
      for (const row of existing.values())
        byUrl.set(sourceCopyKey(row.payload), [
          ...(byUrl.get(sourceCopyKey(row.payload)) || []),
          row,
        ]);
      for (const rows of byUrl.values())
        rows.sort((a, b) => updatedAt.get(b.id) - updatedAt.get(a.id));
      const retired = new Set();
      const previous = (await client.query('SELECT report FROM sources WHERE id = $1', [sourceId]))
        .rows[0]?.report;
      const previousCount = previous?.status === 'ok' ? Number(previous.count) || 0 : 0;
      const sharpDrop = previousCount >= 10 && items.length < previousCount / 2;
      const warning = sharpDrop
        ? `Found ${items.length} listings, down from ${previousCount}` +
          (cancelMissing ? '; cancellations skipped' : '')
        : null;
      const collected = new Set();
      const legacyIds = new Set(
        items.flatMap((item) =>
          (item.occurrences || [])
            .filter((o) => o.id !== item.id && existing.has(o.id))
            .map((o) => o.id),
        ),
      );
      for (const item of items) {
        if (item.source !== sourceId) throw Error('Collected listing belongs to another source');
        if (collected.has(item.id)) continue;
        collected.add(item.id);
        const copies = (byUrl.get(sourceCopyKey(item)) || []).filter(
          (row) => row.id !== item.id && !legacyIds.has(row.id),
        );
        const previous = existing.get(item.id) || copies[0];
        const changed = !previous || contentOf(previous.payload) !== contentOf(item);
        const edited = [existing.get(item.id), ...copies].find((row) => row && hasEdits(row));
        const lastAction = edited?.hidden
          ? (
              await client.query(
                'SELECT action FROM audit_records WHERE listing_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',
                [item.id],
              )
            ).rows[0]?.action
          : null;
        await this.writeRecord(client, {
          id: item.id,
          source: sourceId,
          payload: item,
          hidden: lastAction === 'collect-supersede' ? false : (edited?.hidden ?? false),
          override: edited?.override ?? {},
        });
        if (cancelMissing && complete && item.recurring) {
          const window = collectionWindow(checkedAt);
          await client.query(
            `UPDATE occurrences SET status='cancelled'
            WHERE listing_id=$1 AND NOT(occurrence_id=ANY($2::text[])) AND start_date>=$3 AND start_date<=$4`,
            [item.id, (item.occurrences || []).map((o) => o.id), window.from, window.to],
          );
        }
        for (const occurrence of item.occurrences || []) {
          const old = existing.get(occurrence.id);
          if (!old || old.id === item.id || retired.has(old.id)) continue;
          await this.archiveOccurrence(client, old, item.id, occurrence.id);
          retired.add(old.id);
        }
        for (const copy of copies) {
          await this.retireCopy(client, copy.id, item.id);
          retired.add(copy.id);
          counts.merged++;
        }
        if (!changed) {
          counts.unchanged++;
          continue;
        }
        await client.query('INSERT INTO audit_records(action, listing_id) VALUES ($1, $2)', [
          'collect',
          item.id,
        ]);
        if (previous) counts.updated++;
        else counts.added++;
      }
      // Copies of the same page/session no longer listed collapse into their newest row.
      for (const rows of byUrl.values()) {
        const remaining = rows.filter((row) => !retired.has(row.id) && !collected.has(row.id));
        if (remaining.length < 2 || rows.some((row) => collected.has(row.id))) continue;
        const [kept, ...copies] = remaining;
        const edited = remaining.find(hasEdits);
        if (edited && edited !== kept)
          await this.writeRecord(client, {
            ...kept,
            hidden: edited.hidden,
            override: edited.override,
          });
        for (const copy of copies) {
          await this.retireCopy(client, copy.id, kept.id);
          retired.add(copy.id);
          counts.merged++;
        }
      }
      // Explicitly replaced landing pages and program summaries are discovery-only, even on partial runs.
      // Preserve their payload/edits for recovery; merely missing pages are never hidden.
      const superseded = new Set(supersededUrls);
      const supersededById = new Set(supersededIds);
      for (const [id, row] of existing) {
        if (
          (!superseded.has(row.payload.url) && !supersededById.has(id)) ||
          collected.has(id) ||
          retired.has(id) ||
          row.hidden
        )
          continue;
        await this.writeRecord(client, { ...row, hidden: true });
        await client.query('INSERT INTO audit_records(action, listing_id) VALUES ($1, $2)', [
          'collect-supersede',
          id,
        ]);
      }
      if (cancelMissing && !sharpDrop)
        for (const [id, row] of existing) {
          if (
            collected.has(id) ||
            retired.has(id) ||
            legacyIds.has(id) ||
            row.payload.status === 'cancelled'
          )
            continue;
          if (row.payload.recurring) {
            const window = collectionWindow(checkedAt);
            await client.query(
              `UPDATE occurrences SET status='cancelled' WHERE listing_id=$1 AND start_date>=$2 AND start_date<=$3`,
              [id, window.from, window.to],
            );
            continue;
          }
          await this.writeRecord(
            client,
            { ...row, payload: { ...row.payload, status: 'cancelled' } },
            { preserveEditorial: true },
          );
          await client.query('INSERT INTO audit_records(action, listing_id) VALUES ($1, $2)', [
            'collect-cancel',
            id,
          ]);
          counts.cancelled++;
        }
      await client.query(MERGE_SOURCE_REPORT_SQL, [
        sourceId,
        {
          id: sourceId,
          checkedAt,
          attemptedAt: checkedAt,
          count: complete || !previousCount ? collected.size : previousCount,
          status: 'ok',
          error: null,
        },
      ]);
      return { counts, warning };
    });
  }

  /**
   * Deletes listing `copyId` after moving what must survive to `keptId`: access grants and the
   * audit history. Its child rows (overrides, dates, locations, media links, notes) cascade.
   */
  async retireCopy(client, copyId, keptId) {
    await client.query(
      `INSERT INTO listing_grants(user_id, listing_id)
       SELECT user_id, $2 FROM listing_grants WHERE listing_id = $1 ON CONFLICT DO NOTHING`,
      [copyId, keptId],
    );
    await client.query('UPDATE audit_records SET listing_id = $2 WHERE listing_id = $1', [
      copyId,
      keptId,
    ]);
    const archived = (await client.query(LISTING_ROWS_SQL + ' WHERE l.id=$1', [copyId])).rows[0];
    if (archived)
      await client.query(
        `INSERT INTO event_aliases(legacy_id,listing_id,occurrence_id,archived_record) VALUES($1,$2,NULL,$3) ON CONFLICT DO NOTHING`,
        [copyId, keptId, archived],
      );
    await client.query(
      'INSERT INTO event_alias_media SELECT $1,media_id FROM listing_media WHERE listing_id=$1 ON CONFLICT DO NOTHING',
      [copyId],
    );
    await client.query(`UPDATE occurrences SET listing_id=$2 WHERE listing_id=$1`, [
      copyId,
      keptId,
    ]);
    await client.query('UPDATE event_aliases SET listing_id=$2 WHERE listing_id=$1', [
      copyId,
      keptId,
    ]);
    await client.query('DELETE FROM source_identities WHERE listing_id = $1', [copyId]);
    await client.query('DELETE FROM listings WHERE id = $1', [copyId]);
    await client.query('INSERT INTO audit_records(action, listing_id) VALUES ($1, $2)', [
      'collect-merge',
      keptId,
    ]);
  }

  /** Preserve old saved IDs, session edits/grants and history without duplicate active details. */
  async archiveOccurrence(client, old, eventId, occurrenceId) {
    await client.query(
      `INSERT INTO event_aliases(legacy_id,listing_id,occurrence_id,archived_record) VALUES($1,$2,$3,$4)
      ON CONFLICT(legacy_id) DO NOTHING`,
      [old.id, eventId, occurrenceId, old],
    );
    await client.query(
      'INSERT INTO event_alias_media SELECT $1,media_id FROM listing_media WHERE listing_id=$1 ON CONFLICT DO NOTHING',
      [old.id],
    );
    await client.query(
      'UPDATE occurrences SET hidden=$3,override=$4 WHERE listing_id=$1 AND occurrence_id=$2',
      [eventId, occurrenceId, old.hidden, old.override],
    );
    await client.query(
      `INSERT INTO occurrence_grants SELECT user_id,$2,$3 FROM listing_grants WHERE listing_id=$1 ON CONFLICT DO NOTHING`,
      [old.id, eventId, occurrenceId],
    );
    await client.query(
      'UPDATE audit_records SET listing_id=$2,occurrence_id=$3 WHERE listing_id=$1',
      [old.id, eventId, occurrenceId],
    );
    await client.query('UPDATE source_identities SET listing_id=$2 WHERE listing_id=$1', [
      old.id,
      eventId,
    ]);
    await client.query('DELETE FROM listings WHERE id=$1', [old.id]);
  }

  async occurrenceTarget(id, principal) {
    const params = parameterList([id]);
    const readable = occurrenceAccessClause(principal, params.bind, 'l', 's');
    const row = (
      await this.pool.query(
        `SELECT s.listing_id,s.occurrence_id FROM occurrences s JOIN listings l ON l.id=s.listing_id
      WHERE s.occurrence_id=$1 AND s.listing_id<>$1 AND ${readable} LIMIT 1`,
        params.values,
      )
    ).rows[0];
    return row;
  }

  async updateOccurrence(target, patch, hidden, principal) {
    return writeTransaction(this.pool, async (client) => {
      const params = parameterList([
        target.listing_id,
        target.occurrence_id,
        patch,
        hidden ?? null,
      ]);
      const readable = occurrenceAccessClause(principal, params.bind, 'l', 's');
      const result = await client.query(
        `UPDATE occurrences s SET override=s.override||$3::jsonb,hidden=coalesce($4::boolean,s.hidden)
        FROM listings l WHERE l.id=s.listing_id AND s.listing_id=$1 AND s.occurrence_id=$2 AND ${readable}`,
        params.values,
      );
      if (!result.rowCount) throw Error('Occurrence not found');
      await client.query(
        "INSERT INTO audit_records(action,listing_id,occurrence_id) VALUES('update-occurrence',$1,$2)",
        [target.listing_id, target.occurrence_id],
      );
      return null;
    });
  }

  async availability(id, date, { principal } = {}) {
    const item = await this.detail(id, { admin: true, principal });
    if (!item || item.status === 'hidden') return null;
    const event = item.eventId ? await this.detail(item.eventId, { admin: true, principal }) : item;
    return availabilityOn(event, date);
  }

  /** Worker-only source cache: verified run bounds and reusable private photos. */
  async knownSourceListings(sourceId) {
    const { rows } = await this.pool.query(LISTING_ROWS_SQL + ' WHERE l.source=$1', [sourceId]);
    return new Map(rows.map((row) => [row.id, row.payload]));
  }

  /** Real (non-placeholder) descriptions already stored for a source, keyed by listing URL. */
  async knownDescriptions(sourceId) {
    const result = await this.pool.query(
      `SELECT payload->>'url' AS url, payload->>'description' AS description
       FROM listings WHERE source = $1 AND coalesce(payload->>'description', '') <> ''`,
      [sourceId],
    );
    return new Map(
      result.rows
        .filter((row) => !isPlaceholderDescription(row.description))
        .map((row) => [row.url, row.description]),
    );
  }

  /** Marks a source as failing while keeping its listings and last successful check time. */
  async recordSourceFailure(sourceId, error, attemptedAt) {
    await this.pool.query(MERGE_SOURCE_REPORT_SQL, [
      sourceId,
      { id: sourceId, attemptedAt, status: 'error', error },
    ]);
  }

  /** One listing document, or null if missing or not readable by `principal`. */
  async detail(id, { admin = false, principal } = {}) {
    const params = parameterList([id]);
    const projection = projectedListingsSql(principal, params.bind, false);
    const conditions = ['id=$1', accessClause(principal, params.bind, 'listings', 'event_id')];
    if (!admin) conditions.push(currentListingSql(params.bind(localDay())).trim());
    let result = await this.pool.query(
      `WITH listings AS (${projection}) SELECT document FROM listings WHERE ${conditions.join(' AND ')} LIMIT 1`,
      params.values,
    );
    if (result.rows[0]) return result.rows[0].document;
    const alias = (
      await this.pool.query(
        'SELECT listing_id FROM event_aliases WHERE legacy_id=$1 AND occurrence_id IS NULL',
        [id],
      )
    ).rows[0];
    if (alias && alias.listing_id !== id)
      return this.detail(alias.listing_id, { admin, principal });
    const baseParams = parameterList([id]);
    const base = projectedListingsSql(principal, baseParams.bind, true);
    const readable = accessClause(principal, baseParams.bind, 'listings', 'event_id');
    result = await this.pool.query(
      `WITH listings AS (${base}) SELECT document FROM listings WHERE id=$1 AND ${readable}
      ${admin ? '' : `AND ${currentListingSql(baseParams.bind(localDay()))}`} LIMIT 1`,
      baseParams.values,
    );
    return result.rows[0]?.document || null;
  }

  /**
   * One page of discovery results plus totals, neighbourhood facets and source reports.
   * Non-admin results collapse duplicates by `dedupe_key` and interleave sources by rank.
   */
  async search(filters = {}) {
    const params = parameterList();
    const projection = projectedListingsSql(filters.principal, params.bind, !!filters.admin);
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
           ORDER BY coalesce(document->>'start', ${params.bind(localDay())}), document->>'title', id
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
    const facetProjection = projectedListingsSql(filters.principal, facetParams.bind, false);
    const visible =
      currentListingSql('$1') +
      ' AND ' +
      accessClause(filters.principal, facetParams.bind, 'listings', 'event_id');
    const areas = await this.pool.query(
      `WITH listings AS (${facetProjection}) SELECT DISTINCT document->>'neighbourhood' AS area FROM listings WHERE ${visible} ORDER BY area`,
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
