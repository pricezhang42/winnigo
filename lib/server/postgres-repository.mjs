import { accessClause } from './access.mjs';
import { database, writeTransaction } from './postgres.mjs';
import { resolveMapLocation, collectionLabel } from '../location-resolution.mjs';
import { listingDedupeKey, localDay, weekendRange } from '../connectors.mjs';

const SOCIAL_SOURCES = ['facebook', 'instagram'];

// Child tables rebuilt from the listing document on every write.
const LISTING_CHILD_TABLES = [
  'occurrences',
  'locations',
  'trail_variants',
  'listing_media',
  'comment_notes',
];

// Photos already stored by Winnigo; only these can be attached to a listing.
const STORED_PHOTO_URL = /^\/api\/photos\/[a-f0-9]{64}$/;

// Raw listing rows joined with their editorial overrides.
const LISTING_ROWS_SQL = `
  SELECT l.id, l.source, l.payload, l.hidden, coalesce(o.fields, '{}') AS override
  FROM listings l
  LEFT JOIN listing_overrides o ON o.listing_id = l.id`;

// Hides hidden, cancelled and already-finished listings from non-admin readers.
// `todayParam` is the bound placeholder for today's Winnipeg date.
const currentListingSql = (todayParam) => `
  NOT hidden
  AND coalesce(document->>'status', 'active') NOT IN ('hidden', 'cancelled')
  AND coalesce(document->>'end', '9999-12-31') >= ${todayParam}`;

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

/** Builds the WHERE clauses for a discovery search. Access control is always the first clause. */
function searchClauses(filters, bind) {
  const doc = 'document';
  const clauses = [accessClause(filters.principal, bind)];
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
  if (['Today', 'This weekend'].includes(filters.quick)) {
    const today = localDay();
    const { first, last } =
      filters.quick === 'This weekend' ? weekendRange(today) : { first: today, last: today };
    clauses.push(
      `${doc}->>'schedule' = 'event'`,
      `${doc}->>'start' <= ${bind(last)}`,
      `coalesce(${doc}->>'end', ${doc}->>'start') >= ${bind(first)}`,
    );
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
    const [listings, sources] = await Promise.all([
      this.pool.query(LISTING_ROWS_SQL),
      this.pool.query('SELECT report FROM sources'),
    ]);
    return {
      version: 1,
      listings: listings.rows,
      sources: sources.rows.map((row) => row.report),
    };
  }

  /**
   * Upserts one listing and rebuilds its child rows inside the caller's transaction.
   * With `preserveEditorial`, an existing listing keeps its hidden flag and owner overrides.
   */
  async writeRecord(client, record, { preserveEditorial = false } = {}) {
    const item = record.payload;
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
    await this.replaceChildRows(client, record.id, doc);
  }

  async replaceChildRows(client, listingId, doc) {
    for (const table of LISTING_CHILD_TABLES)
      await client.query(`DELETE FROM ${table} WHERE listing_id = $1`, [listingId]);

    if (doc.start)
      await client.query('INSERT INTO occurrences VALUES ($1, 0, $2)', [
        listingId,
        { start: doc.start, end: doc.end || doc.start, time: doc.time, schedule: doc.schedule },
      ]);
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
   * marked cancelled, never deleted. Returns counts; `updated` means the content changed, not just
   * the check time. Only content changes are written to the audit log.
   */
  async applySourceCollection(sourceId, items, { checkedAt, cancelMissing = false }) {
    return writeTransaction(this.pool, async (client) => {
      const existing = new Map(
        (await client.query(LISTING_ROWS_SQL + ' WHERE l.source = $1', [sourceId])).rows.map(
          (row) => [row.id, row],
        ),
      );
      const counts = { found: items.length, added: 0, updated: 0, unchanged: 0, cancelled: 0 };
      const collected = new Set();
      for (const item of items) {
        if (item.source !== sourceId) throw Error('Collected listing belongs to another source');
        if (collected.has(item.id)) continue;
        collected.add(item.id);
        const previous = existing.get(item.id);
        const changed = !previous || contentOf(previous.payload) !== contentOf(item);
        await this.writeRecord(
          client,
          { id: item.id, source: sourceId, payload: item, hidden: false, override: {} },
          { preserveEditorial: true },
        );
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
      if (cancelMissing)
        for (const [id, row] of existing) {
          if (collected.has(id) || row.payload.status === 'cancelled') continue;
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
          count: collected.size,
          status: 'ok',
          error: null,
        },
      ]);
      return counts;
    });
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
    const conditions = ['id = $1', accessClause(principal, params.bind)];
    if (!admin) conditions.push(currentListingSql(params.bind(localDay())).trim());
    const result = await this.pool.query(
      'SELECT document FROM listings WHERE ' + conditions.join(' AND '),
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
    const clauses = searchClauses(filters, params.bind);
    const limit = Math.min(100, Math.max(1, filters.limit || 24));
    const offset = filters.offset || 0;
    const duplicateKey = filters.admin ? 'id' : 'dedupe_key';

    // One statement, so the count and the page come from the same snapshot.
    const page = await this.pool.query(
      `WITH filtered AS (
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
    const visible =
      currentListingSql('$1') + ' AND ' + accessClause(filters.principal, facetParams.bind);
    const areas = await this.pool.query(
      `SELECT DISTINCT document->>'neighbourhood' AS area FROM listings WHERE ${visible} ORDER BY area`,
      facetParams.values,
    );
    const reports = await this.sourceReports(filters.principal, visible, facetParams.values);

    const { total, items } = page.rows[0];
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
  async sourceReports(principal, visibleSql, values) {
    if (principal?.role === 'owner')
      return (await this.pool.query('SELECT report FROM sources ORDER BY id')).rows.map(
        (row) => row.report,
      );
    const counts = await this.pool.query(
      `SELECT source AS id, count(*)::int AS count, max(document->>'checkedAt') AS "checkedAt"
       FROM listings WHERE ${visibleSql} GROUP BY source`,
      values,
    );
    return counts.rows.map((row) => ({ ...row, status: 'ok' }));
  }
}
