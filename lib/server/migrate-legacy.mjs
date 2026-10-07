import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { contentHash } from './s3-storage.mjs';
import { identity } from './postgres-repository.mjs';
const BATCH_SIZE = 40;

/**
 * Validates a legacy export manifest and the photo files beside it without touching the
 * database: IDs, source identities, photo hashes/sizes and that every referenced photo exists.
 */
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
  const directory = await realpath(dirname(resolve(file)));
  const ids = new Set();
  const identities = new Set();
  const photos = new Map();
  for (const media of manifest.media) {
    if (
      !/^[a-f0-9]{64}$/.test(media.id) ||
      media.file !== 'photos/' + media.id ||
      photos.has(media.id) ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(media.contentType)
    )
      throw Error('Invalid or duplicate manifest media');
    const path = await realpath(resolve(directory, media.file));
    if (!path.startsWith(directory + sep)) throw Error('Media path escapes export directory');
    const blob = await readFile(path);
    if (
      blob.length > 8 * 1024 * 1024 ||
      blob.length !== media.size ||
      contentHash(blob) !== media.id
    )
      throw Error('Export media integrity mismatch');
    photos.set(media.id, { ...media, path });
  }
  for (const record of manifest.listings) {
    if (
      !record.id ||
      record.id !== record.payload?.id ||
      record.source !== record.payload?.source ||
      !record.payload.title ||
      !record.payload.venue ||
      typeof record.hidden !== 'boolean' ||
      !record.override ||
      typeof record.override !== 'object' ||
      Array.isArray(record.override) ||
      ids.has(record.id)
    )
      throw Error('Invalid or duplicate listing record');
    ids.add(record.id);
    const key = record.source + '\0' + identity(record);
    if (identities.has(key))
      throw Error('Conflicting duplicate source identity; review before migration');
    identities.add(key);
    for (const url of [
      ...(record.payload.images || []),
      record.payload.image,
      ...(record.override.images || []),
      record.override.image,
    ].filter(Boolean))
      if (url.startsWith('/api/photos/') && !photos.has(url.split('/').pop()))
        throw Error('Export is missing a referenced photo');
  }
  return { manifest, hash: contentHash(bytes), photos };
}
/**
 * Imports a legacy export into PostgreSQL/S3. Without `apply` it is a dry run that only reports.
 *
 * The run is resumable: it holds an advisory lock per manifest, records checkpoints in
 * `migration_runs`, keeps existing hidden flags/overrides, and finally reconciles every listing,
 * gallery order and photo against the manifest. `stopAfter` simulates an interruption in tests.
 */
export async function migrateLegacy(
  file,
  { repository, storage, apply = false, stopAfter = Infinity } = {},
) {
  const { manifest, hash, photos } = await prepareMigration(file);
  const pool = repository.pool;
  for (const record of manifest.listings) {
    const existing = await pool.query(
      'SELECT listing_id FROM source_identities WHERE source=$1 AND external_key=$2',
      [record.source, identity(record)],
    );
    if (existing.rows[0] && existing.rows[0].listing_id !== record.id)
      throw Error('Target stable ID conflict; review migration mapping');
  }
  const report = {
    dryRun: !apply,
    listings: manifest.listings.length,
    media: photos.size,
    idMap: Object.fromEntries(manifest.listings.map((record) => [record.id, record.id])),
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
    // Editorial state to preserve: the target's if the listing already exists, else the export's.
    const editorial = new Map();
    for (const record of manifest.listings) {
      const old = (
        await pool.query(
          "SELECT hidden,coalesce(fields,'{}') AS override FROM listings LEFT JOIN listing_overrides ON listing_id=id WHERE id=$1",
          [record.id],
        )
      ).rows[0];
      editorial.set(record.id, old || record);
    }
    const run = 'legacy-' + hash;
    await pool.query(
      "INSERT INTO migration_runs(id,manifest_hash,status) VALUES($1,$2,'running') ON CONFLICT(id) DO UPDATE SET status='running',updated_at=now()",
      [run, hash],
    );
    let processed = 0;
    for (const media of photos.values()) {
      await storage.put(media.id, await readFile(media.path), media.contentType);
      processed++;
      await pool.query('UPDATE migration_runs SET checkpoint=$2,updated_at=now() WHERE id=$1', [
        run,
        { media: processed, listings: 0 },
      ]);
      if (processed >= stopAfter) throw Error('Simulated interrupted migration');
    }
    for (let index = 0; index < manifest.listings.length; index += BATCH_SIZE) {
      await repository.importRecords(manifest.listings.slice(index, index + BATCH_SIZE));
      await pool.query('UPDATE migration_runs SET checkpoint=$2,updated_at=now() WHERE id=$1', [
        run,
        { media: photos.size, listings: Math.min(index + BATCH_SIZE, manifest.listings.length) },
      ]);
    }
    await repository.importRecords([], manifest.sources);
    // Verify committed IDs and original payloads, ordered associations and object checksums.
    for (const record of manifest.listings) {
      const target = (
        await pool.query(
          "SELECT payload,source,hidden,coalesce(fields,'{}') AS override FROM listings LEFT JOIN listing_overrides ON listing_id=id WHERE id=$1",
          [record.id],
        )
      ).rows[0];
      if (
        !target ||
        target.source !== record.source ||
        JSON.stringify(sortedKeys(target.payload)) !== JSON.stringify(sortedKeys(record.payload))
      )
        throw Error('Listing reconciliation failed');
      const preserved = editorial.get(record.id);
      if (
        target.hidden !== preserved.hidden ||
        JSON.stringify(sortedKeys(target.override)) !==
          JSON.stringify(sortedKeys(preserved.override))
      )
        throw Error('Editorial reconciliation failed');
      const effective = { ...record.payload, ...target.override };
      const actual = (
        await pool.query(
          'SELECT media_id FROM listing_media WHERE listing_id=$1 ORDER BY ordinal',
          [record.id],
        )
      ).rows.map((row) => row.media_id);
      const expected = [
        ...new Set(
          [...(effective.images || []), effective.image].filter((url) =>
            url?.startsWith('/api/photos/'),
          ),
        ),
      ].map((url) => url.split('/').pop());
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
/** Deep copy with object keys sorted, so JSON comparisons ignore key order. */
function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortedKeys(value[key])]),
    );
  return value;
}
