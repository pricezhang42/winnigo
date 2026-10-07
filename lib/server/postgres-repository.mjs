import { accessClause } from './access.mjs';
import { database, writeTransaction } from './postgres.mjs';
import { resolveMapLocation, collectionLabel } from '../location-resolution.mjs';
import { listingDedupeKey, localDay } from '../connectors.mjs';
export function canonical(url) {
  const parsed = new URL(url);
  if (parsed.hostname === 'www.facebook.com') parsed.hostname = 'facebook.com';
  for (const key of [...parsed.searchParams.keys()])
    if (!['story_fbid', 'id', 'fbid'].includes(key)) parsed.searchParams.delete(key);
  parsed.searchParams.sort();
  parsed.hash = '';
  return parsed.href;
}
export function identity(record) {
  return ['facebook', 'instagram'].includes(record.source)
    ? canonical(record.payload.url)
    : record.id;
}
export function documentFor(record) {
  const item = {
    ...record.payload,
    ...record.override,
    id: record.id,
    status: record.hidden ? 'hidden' : record.payload.status,
  };
  return { ...item, collection: collectionLabel(item), mapLocation: resolveMapLocation(item) };
}
const rowsSql = `SELECT l.id,l.source,l.payload,l.hidden,coalesce(o.fields,'{}') AS override FROM listings l LEFT JOIN listing_overrides o ON o.listing_id=l.id`;
export class PostgresRepository {
  constructor(pool = database()) {
    this.pool = pool;
  }
  async health() {
    await this.pool.query('SELECT 1 FROM listings LIMIT 1');
    return true;
  }
  async read() {
    const [listings, sources] = await Promise.all([
      this.pool.query(rowsSql),
      this.pool.query('SELECT report FROM sources'),
    ]);
    return { version: 1, listings: listings.rows, sources: sources.rows.map((s) => s.report) };
  }
  async writeRecord(client, record, { preserveEditorial = false } = {}) {
    const item = record.payload;
    if (record.id !== item.id || record.source !== item.source || !item.title || !item.url)
      throw Error('Invalid listing identity');
    await client.query('INSERT INTO sources(id,report) VALUES($1,$2) ON CONFLICT DO NOTHING', [
      record.source,
      { id: record.source, status: 'pending', count: 0, checkedAt: '' },
    ]);
    const old = await client.query(rowsSql + ' WHERE l.id=$1', [record.id]);
    if (old.rows[0] && old.rows[0].source !== record.source)
      throw Error('A stable listing ID cannot change source');
    if (preserveEditorial && old.rows[0])
      record = { ...record, hidden: old.rows[0].hidden, override: old.rows[0].override };
    const doc = documentFor(record),
      key = identity(record);
    const existing = await client.query(
      'SELECT listing_id FROM source_identities WHERE source=$1 AND external_key=$2',
      [record.source, key],
    );
    if (existing.rows[0] && existing.rows[0].listing_id !== record.id)
      throw Error('Source identity conflicts with a different stable listing ID');
    await client.query(
      `INSERT INTO listings(id,source,payload,document,hidden,visibility,dedupe_key) VALUES($1,$2,$3,$4,$5,$6,$7)
   ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,document=excluded.document,hidden=excluded.hidden,visibility=excluded.visibility,dedupe_key=excluded.dedupe_key,updated_at=now()`,
      [
        record.id,
        record.source,
        item,
        doc,
        record.hidden,
        ['facebook', 'instagram'].includes(record.source) || item.sourceVisibility === 'private'
          ? 'restricted'
          : 'public',
        listingDedupeKey(doc),
      ],
    );
    await client.query(
      'INSERT INTO source_identities(source,external_key,listing_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [record.source, key, record.id],
    );
    await client.query(
      'INSERT INTO listing_overrides VALUES($1,$2) ON CONFLICT(listing_id) DO UPDATE SET fields=excluded.fields',
      [record.id, record.override || {}],
    );
    for (const table of [
      'occurrences',
      'locations',
      'trail_variants',
      'listing_media',
      'comment_notes',
    ])
      await client.query(`DELETE FROM ${table} WHERE listing_id=$1`, [record.id]);
    if (doc.start)
      await client.query('INSERT INTO occurrences VALUES($1,0,$2)', [
        record.id,
        { start: doc.start, end: doc.end || doc.start, time: doc.time, schedule: doc.schedule },
      ]);
    if (doc.mapLocation)
      await client.query('INSERT INTO locations VALUES($1,$2)', [record.id, doc.mapLocation]);
    for (const [n, v] of (doc.trailVariants || []).entries())
      await client.query('INSERT INTO trail_variants VALUES($1,$2,$3)', [record.id, n, v]);
    const images = [...new Set([...(doc.images || []), ...(doc.image ? [doc.image] : [])])].filter(
      (url) => /^\/api\/photos\/[a-f0-9]{64}$/.test(url),
    );
    for (const [n, url] of images.entries()) {
      const id = url.split('/').pop();
      const media = await client.query("SELECT 1 FROM media WHERE id=$1 AND status='ready'", [id]);
      if (!media.rowCount) throw Error('Referenced photo has not completed upload');
      await client.query('INSERT INTO listing_media VALUES($1,$2,$3)', [record.id, id, n]);
    }
    for (const [n, note] of (doc.commentNotes || []).entries())
      await client.query('INSERT INTO comment_notes VALUES($1,$2,$3,$4)', [
        record.id,
        n,
        note.text,
        note.url,
      ]);
  }
  async transaction(change, scope) {
    return writeTransaction(this.pool, async (client) => {
      let where = '',
        params = [];
      if (scope?.action === 'update') {
        where = ' WHERE l.id=$1';
        params = [scope.id];
      } else if (scope?.urls) {
        where =
          ' WHERE l.id IN (SELECT listing_id FROM source_identities WHERE external_key=ANY($1::text[]))';
        params = [scope.urls.map(canonical)];
      }
      if (scope?.principal) {
        const predicate = accessClause(
          scope.principal,
          (v) => {
            params.push(v);
            return '$' + params.length;
          },
          'l',
        );
        where += (where ? ' AND ' : ' WHERE ') + predicate;
      }
      const initial = (await client.query(rowsSql + where, params)).rows;
      const reports = (await client.query('SELECT report FROM sources')).rows.map((r) => r.report);
      const state = {
        version: 1,
        listings: structuredClone(initial),
        sources: structuredClone(reports),
      };
      const result = await change(state);
      const before = new Map(initial.map((r) => [r.id, JSON.stringify(r)]));
      for (const record of state.listings)
        if (before.get(record.id) !== JSON.stringify(record)) {
          await this.writeRecord(client, record);
          await client.query('INSERT INTO audit_records(action,listing_id) VALUES($1,$2)', [
            scope?.action || 'upsert',
            record.id,
          ]);
        }
      for (const report of state.sources)
        if (JSON.stringify(reports.find((r) => r.id === report.id)) !== JSON.stringify(report))
          await client.query(
            'INSERT INTO sources VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET report=excluded.report',
            [report.id, report],
          );
      if (scope?.action === 'sync-hiking-manitoba')
        await client.query('INSERT INTO collection_runs(source,status,counts) VALUES($1,$2,$3)', [
          'facebook',
          result.status,
          { processed: result.processed, added: result.added, updated: result.updated },
        ]);
      return result;
    });
  }
  async importRecords(records, sources = []) {
    return writeTransaction(this.pool, async (client) => {
      for (const record of records)
        await this.writeRecord(client, record, { preserveEditorial: true });
      for (const report of sources)
        await client.query(
          'INSERT INTO sources VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET report=excluded.report',
          [report.id, report],
        );
    });
  }
  async detail(id, { admin = false, principal } = {}) {
    const values = [id],
      bind = (v) => {
        values.push(v);
        return '$' + values.length;
      };
    const access = accessClause(principal, bind);
    const result = await this.pool.query(
      'SELECT document FROM listings WHERE id=$1 AND ' +
        access +
        (admin
          ? ''
          : " AND NOT hidden AND coalesce(document->>'status','active') NOT IN ('hidden','cancelled') AND coalesce(document->>'end','9999-12-31') >= " +
            bind(localDay())),
      values,
    );
    return result.rows[0]?.document || null;
  }
  async search(q = {}) {
    const values = [];
    const bind = (v) => {
      values.push(v);
      return '$' + values.length;
    };
    const clauses = [accessClause(q.principal, bind)];
    const d = 'document';
    if (!q.admin) {
      clauses.push(
        'NOT hidden',
        `coalesce(${d}->>'status','active') NOT IN ('hidden','cancelled')`,
        `coalesce(${d}->>'end','9999-12-31')>=${bind(localDay())}`,
      );
    }
    if (q.query)
      clauses.push(
        `strpos(lower(concat_ws(' ',${d}->>'title',${d}->>'venue',${d}->>'category',${q.admin ? d + "->>'sourceName'" : "''"})),lower(${bind(q.query)}))>0`,
      );
    if (q.collection && q.collection !== 'All discoveries')
      clauses.push(`${d}->>'collection'=${bind(q.collection)}`);
    if (q.category && q.category !== 'All')
      clauses.push(
        `(${d}->>'category'=${bind(q.category)} OR coalesce(${d}->'activityCategories','[]') ? ${bind(q.category)} ${q.category === 'Outdoors' ? `OR ${d}->>'category' IN ('Hiking','Cycling')` : ''})`,
      );
    if (q.area && q.area !== 'All neighbourhoods')
      clauses.push(`${d}->>'neighbourhood'=${bind(q.area)}`);
    const type = { Events: 'Event', Places: 'Place', Activities: 'Activity' }[q.tab];
    if (type) clauses.push(`${d}->>'type'=${bind(type)}`);
    if (q.tab === 'Saved') clauses.push(`id=ANY(${bind(q.ids || [])}::text[])`);
    if (q.tab === 'Trail map')
      clauses.push(`(source='trails-manitoba' OR ${d}->>'category' IN ('Hiking','Cycling'))`);
    if (q.quick === 'Free') clauses.push(`${d}->'price'='0'::jsonb`);
    if (q.quick === 'Family-friendly') clauses.push(`${d}->'family'='true'::jsonb`);
    if (q.quick === 'Indoors') clauses.push(`${d}->'indoor'='true'::jsonb`);
    if (['Today', 'This weekend'].includes(q.quick)) {
      const today = localDay();
      let first = today,
        last = today;
      if (q.quick === 'This weekend') {
        const date = new Date(today + 'T12:00:00Z'),
          day = date.getUTCDay();
        date.setUTCDate(date.getUTCDate() + (day === 0 ? -2 : day === 6 ? -1 : 5 - day));
        first = date.toISOString().slice(0, 10);
        date.setUTCDate(date.getUTCDate() + 2);
        last = date.toISOString().slice(0, 10);
      }
      clauses.push(
        `${d}->>'schedule'='event'`,
        `${d}->>'start'<=${bind(last)}`,
        `coalesce(${d}->>'end',${d}->>'start')>=${bind(first)}`,
      );
    }
    if (q.season && q.season !== 'Any')
      clauses.push(`coalesce(${d}->'seasons','[]') ? ${bind(q.season)}`);
    if (q.difficulty && q.difficulty !== 'Any')
      clauses.push(`coalesce(${d}->>'difficulty','Unknown')=${bind(q.difficulty)}`);
    if (q.distance && q.distance !== 'Any')
      clauses.push(
        q.distance === 'short'
          ? `(${d}->>'distanceKm')::numeric<=5`
          : q.distance === 'medium'
            ? `(${d}->>'distanceKm')::numeric>5 AND (${d}->>'distanceKm')::numeric<=15`
            : `(${d}->>'distanceKm')::numeric>15`,
      );
    const limit = Math.min(100, Math.max(1, q.limit || 24)),
      offset = q.offset || 0;
    const base = `WITH filtered AS (SELECT *, row_number() OVER(PARTITION BY ${q.admin ? 'id' : 'dedupe_key'} ORDER BY id) AS duplicate FROM listings WHERE ${clauses.join(' AND ') || 'true'}), unique_items AS (SELECT * FROM filtered WHERE duplicate=1), ranked AS (SELECT *, row_number() OVER(PARTITION BY source ORDER BY coalesce(document->>'start',${bind(localDay())}),document->>'title',id) AS source_rank FROM unique_items)`;
    // One MVCC statement produces counts and bounded items from the same snapshot.
    const result = await this.pool.query(
      base +
        ` SELECT (SELECT count(*)::int FROM unique_items) AS total, coalesce((SELECT jsonb_agg(document ORDER BY source_rank,source,id) FROM (SELECT * FROM ranked ORDER BY source_rank,source,id LIMIT ${bind(limit)} OFFSET ${bind(offset)}) page),'[]') AS items`,
      values,
    );
    const facetValues = [localDay()],
      facetBind = (v) => {
        facetValues.push(v);
        return '$' + facetValues.length;
      };
    const access = accessClause(q.principal, facetBind);
    const facets = await this.pool.query(
      "SELECT DISTINCT document->>'neighbourhood' AS area FROM listings WHERE NOT hidden AND coalesce(document->>'status','active') NOT IN ('hidden','cancelled') AND coalesce(document->>'end','9999-12-31') >= $1 AND " +
        access +
        ' ORDER BY area',
      facetValues,
    );
    let sources;
    if (q.principal?.role === 'owner')
      sources = (await this.pool.query('SELECT report FROM sources ORDER BY id')).rows.map(
        (r) => r.report,
      );
    else
      sources = (
        await this.pool.query(
          "SELECT source AS id,count(*)::int AS count,max(document->>'checkedAt') AS \"checkedAt\" FROM listings WHERE NOT hidden AND coalesce(document->>'status','active') NOT IN ('hidden','cancelled') AND coalesce(document->>'end','9999-12-31') >= $1 AND " +
            access +
            ' GROUP BY source',
          facetValues,
        )
      ).rows.map((r) => ({ ...r, status: 'ok' }));
    const { total, items } = result.rows[0];
    return {
      items,
      total,
      nextOffset: offset + items.length < total ? offset + items.length : null,
      areas: facets.rows.map((r) => r.area).filter(Boolean),
      reports: sources,
    };
  }
}
