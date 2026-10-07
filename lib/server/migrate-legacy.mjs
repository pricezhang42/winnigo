import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { contentHash } from './s3-storage.mjs';
import { identity } from './postgres-repository.mjs';
export async function prepareMigration(file) {
  const bytes = await readFile(file);
  const manifest = JSON.parse(bytes);
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.listings) ||
    !Array.isArray(manifest.sources) ||
    !Array.isArray(manifest.media)
  )
    throw Error('Unsupported migration manifest');
  const directory = await realpath(dirname(resolve(file))),
    ids = new Set(),
    identities = new Set(),
    photos = new Map();
  for (const m of manifest.media) {
    if (
      !/^[a-f0-9]{64}$/.test(m.id) ||
      m.file !== 'photos/' + m.id ||
      photos.has(m.id) ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(m.contentType)
    )
      throw Error('Invalid or duplicate manifest media');
    const path = await realpath(resolve(directory, m.file));
    if (!path.startsWith(directory + sep)) throw Error('Media path escapes export directory');
    const blob = await readFile(path);
    if (blob.length > 8 * 1024 * 1024 || blob.length !== m.size || contentHash(blob) !== m.id)
      throw Error('Export media integrity mismatch');
    photos.set(m.id, { ...m, path });
  }
  for (const r of manifest.listings) {
    if (
      !r.id ||
      r.id !== r.payload?.id ||
      r.source !== r.payload?.source ||
      !r.payload.title ||
      !r.payload.venue ||
      typeof r.hidden !== 'boolean' ||
      !r.override ||
      typeof r.override !== 'object' ||
      Array.isArray(r.override) ||
      ids.has(r.id)
    )
      throw Error('Invalid or duplicate listing record');
    ids.add(r.id);
    const key = r.source + '\0' + identity(r);
    if (identities.has(key))
      throw Error('Conflicting duplicate source identity; review before migration');
    identities.add(key);
    for (const url of [
      ...(r.payload.images || []),
      r.payload.image,
      ...(r.override.images || []),
      r.override.image,
    ].filter(Boolean))
      if (url.startsWith('/api/photos/') && !photos.has(url.split('/').pop()))
        throw Error('Export is missing a referenced photo');
  }
  return { manifest, hash: contentHash(bytes), photos };
}
export async function migrateLegacy(
  file,
  { repository, storage, apply = false, stopAfter = Infinity } = {},
) {
  const { manifest, hash, photos } = await prepareMigration(file);
  const pool = repository.pool;
  for (const r of manifest.listings) {
    const existing = await pool.query(
      'SELECT listing_id FROM source_identities WHERE source=$1 AND external_key=$2',
      [r.source, identity(r)],
    );
    if (existing.rows[0] && existing.rows[0].listing_id !== r.id)
      throw Error('Target stable ID conflict; review migration mapping');
  }
  const report = {
    dryRun: !apply,
    listings: manifest.listings.length,
    media: photos.size,
    idMap: Object.fromEntries(manifest.listings.map((r) => [r.id, r.id])),
    manifestHash: hash,
  };
  if (!apply) return report;
  const lock = await pool.connect();
  if (
    !(await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', ['legacy-' + hash]))
      .rows[0].acquired
  ) {
    lock.release();
    throw Error('This migration is already running');
  }
  try {
    const editorial = new Map();
    for (const r of manifest.listings) {
      const old = (
        await pool.query(
          "SELECT hidden,coalesce(fields,'{}') AS override FROM listings LEFT JOIN listing_overrides ON listing_id=id WHERE id=$1",
          [r.id],
        )
      ).rows[0];
      editorial.set(r.id, old || r);
    }
    const run = 'legacy-' + hash;
    await pool.query(
      "INSERT INTO migration_runs(id,manifest_hash,status) VALUES($1,$2,'running') ON CONFLICT(id) DO UPDATE SET status='running',updated_at=now()",
      [run, hash],
    );
    let processed = 0;
    for (const m of photos.values()) {
      await storage.put(m.id, await readFile(m.path), m.contentType);
      processed++;
      await pool.query('UPDATE migration_runs SET checkpoint=$2,updated_at=now() WHERE id=$1', [
        run,
        { media: processed, listings: 0 },
      ]);
      if (processed >= stopAfter) throw Error('Simulated interrupted migration');
    }
    for (let index = 0; index < manifest.listings.length; index += 40) {
      await repository.importRecords(manifest.listings.slice(index, index + 40));
      await pool.query('UPDATE migration_runs SET checkpoint=$2,updated_at=now() WHERE id=$1', [
        run,
        { media: photos.size, listings: Math.min(index + 40, manifest.listings.length) },
      ]);
    }
    await repository.importRecords([], manifest.sources);
    // Verify committed IDs and original payloads, ordered associations and object checksums.
    for (const r of manifest.listings) {
      const target = (
        await pool.query(
          "SELECT payload,source,hidden,coalesce(fields,'{}') AS override FROM listings LEFT JOIN listing_overrides ON listing_id=id WHERE id=$1",
          [r.id],
        )
      ).rows[0];
      if (
        !target ||
        target.source !== r.source ||
        JSON.stringify(sort(target.payload)) !== JSON.stringify(sort(r.payload))
      )
        throw Error('Listing reconciliation failed');
      const preserved = editorial.get(r.id);
      if (
        target.hidden !== preserved.hidden ||
        JSON.stringify(sort(target.override)) !== JSON.stringify(sort(preserved.override))
      )
        throw Error('Editorial reconciliation failed');
      const effective = { ...r.payload, ...target.override };
      const actual = (
        await pool.query(
          'SELECT media_id FROM listing_media WHERE listing_id=$1 ORDER BY ordinal',
          [r.id],
        )
      ).rows.map((x) => x.media_id);
      const expected = [
        ...new Set(
          [...(effective.images || []), effective.image].filter((u) =>
            u?.startsWith('/api/photos/'),
          ),
        ),
      ].map((u) => u.split('/').pop());
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw Error('Gallery order reconciliation failed');
    }
    for (const id of photos.keys())
      if (!(await storage.get(id))) throw Error('Photo reconciliation failed');
    await pool.query(
      "UPDATE migration_runs SET status='complete',report=$2,updated_at=now() WHERE id=$1",
      [run, report],
    );
    return { ...report, run, status: 'complete' };
  } finally {
    try {
      await lock.query('SELECT pg_advisory_unlock(hashtext($1))', ['legacy-' + hash]);
    } finally {
      lock.release();
    }
  }
}
function sort(v) {
  if (Array.isArray(v)) return v.map(sort);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sort(v[k])]),
    );
  return v;
}
