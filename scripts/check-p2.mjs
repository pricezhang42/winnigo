// P2 integration check (npm run check:p2): runs migrations in a temporary PostgreSQL schema and
// S3 prefix, then exercises imports, search, overrides, media and legacy migration.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serviceConfig } from './check-services.mjs';
import { PostgresRepository } from '../lib/server/postgres-repository.mjs';
import { S3Storage, contentHash } from '../lib/server/s3-storage.mjs';
import { qaImage } from '../lib/server/qa-image.mjs';
import { applyAction } from '../lib/server/actions.mjs';
import { migrateLegacy } from '../lib/server/migrate-legacy.mjs';
const config = serviceConfig(),
  schema = 'p2_test_' + Date.now(),
  admin = new Pool({ connectionString: config.connectionString });
const pool = new Pool({
  connectionString: config.connectionString,
  options: `-c search_path=${schema}`,
  max: 8,
});
const client = new S3Client(config.s3),
  storage = new S3Storage({
    pool,
    client,
    bucket: config.bucket,
    prefix: schema.replaceAll('_', '-') + '/',
  }),
  repo = new PostgresRepository(pool);
const search = repo.search.bind(repo),
  detail = repo.detail.bind(repo);
repo.search = (filters) =>
  search({ ...filters, principal: { userId: 'test-owner', role: 'owner' } });
repo.detail = (id, filters) =>
  detail(id, { ...filters, principal: { userId: 'test-owner', role: 'owner' } });
const dir = await mkdtemp(join(tmpdir(), 'winnigo-p2-')),
  objects = [];
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  for (const file of ['0001_foundation.sql', '0002_discovery.sql'])
    await pool.query(await readFile('migrations/postgres/' + file, 'utf8'));
  const photos = [qaImage([11, 22, 33]), qaImage([44, 55, 66])];
  for (const bytes of photos) {
    const id = contentHash(bytes);
    objects.push(id);
    await storage.put(id, bytes, 'image/png');
    assert.deepEqual(Buffer.from((await storage.get(id)).bytes), bytes);
  }
  await storage.put(objects[0], photos[0], 'image/png');
  await assert.rejects(storage.put(objects[0], photos[1], 'image/png'), /hash/);
  await assert.rejects(storage.put(objects[0], photos[0], 'image/jpeg'), /collision/);
  const publicRead = await fetch(
    `${config.s3.endpoint}/${config.bucket}/${storage.key(objects[0])}`,
  );
  assert.equal(publicRead.status, 403);
  const fixture = JSON.parse(
    await readFile('scripts/fixtures/p0-discovery.json', 'utf8'),
  ).community;
  const raw = { ...fixture, images: objects.map((id) => '/api/photos/' + id) };
  const batch = { action: 'sync-hiking-manitoba', status: 'ok', items: [raw] };
  assert.equal((await applyAction(batch, repo)).added, 1);
  const row = (await repo.read()).listings[0],
    id = row.id;
  await applyAction(
    { action: 'update', id, title: 'Owner correction', hidden: true, price: 5 },
    repo,
  );
  const repeats = await Promise.all([applyAction(batch, repo), applyAction(batch, repo)]);
  assert.ok(repeats.every((r) => r.added === 0));
  assert.equal((await repo.read()).listings.length, 1);
  assert.equal(await repo.detail(id), null);
  assert.equal((await repo.detail(id, { admin: true })).title, 'Owner correction');
  assert.equal((await repo.detail(id, { admin: true })).price, 5);
  const before = (await pool.query('SELECT count(*) FROM collection_runs')).rows[0].count;
  await assert.rejects(
    applyAction(
      {
        ...batch,
        items: [
          {
            ...raw,
            url: raw.url.replace('001/', '099/'),
            images: ['/api/photos/' + 'f'.repeat(64)],
          },
        ],
      },
      repo,
    ),
    /upload/,
  );
  assert.equal((await repo.read()).listings.length, 1);
  assert.equal((await pool.query('SELECT count(*) FROM collection_runs')).rows[0].count, before);
  await applyAction({ action: 'update', id, hidden: false }, repo);
  await assert.rejects(
    repo.importRecords([{ ...row, source: 'other', payload: { ...row.payload, source: 'other' } }]),
    /change source/,
  );
  await assert.rejects(storage.delete(objects[0]), /Referenced/);
  const records = Array.from({ length: 8 }, (_, i) => ({
    id: 'extra-' + i,
    source: i % 2 ? 'official' : 'calendar',
    hidden: false,
    override: {},
    payload: {
      id: 'extra-' + i,
      source: i % 2 ? 'official' : 'calendar',
      title: 'Distinct ' + i,
      url: 'https://example.com/' + i,
      venue: 'Fixture',
      category: 'Hiking',
      price: i % 2 ? null : 0,
      status: 'active',
      schedule: 'unscheduled',
    },
  }));
  await repo.importRecords(records);
  const page = await repo.search({ limit: 3 });
  assert.equal(page.total, 9);
  assert.equal(page.items.length, 3);
  assert.equal(new Set(page.items.map((i) => i.source)).size, 3);
  const next = await repo.search({ limit: 3, offset: 3 });
  assert.ok(next.items.every((i) => !page.items.some((p) => p.id === i.id)));
  assert.equal((await repo.search({ query: "%' OR 1=1 --" })).total, 0);
  assert.equal((await repo.search({ quick: 'Free' })).total, 4);
  assert.equal((await repo.search({ tab: 'Saved', ids: [id] })).total, 1);
  const detail = await repo.detail(id);
  assert.equal(detail.collection, 'Community Highlights');
  assert.ok(detail.mapLocation);
  assert.equal(detail.distanceKm, null);
  assert.equal(detail.commentNotes.length, 1);
  // Export fixture, dry-run, interrupted copy, restart, stable IDs and editorial preservation.
  await mkdir(join(dir, 'photos'));
  for (let i = 0; i < photos.length; i++)
    await writeFile(join(dir, 'photos', objects[i]), photos[i]);
  const manifest = {
    version: 1,
    sources: [],
    listings: [row],
    media: photos.map((bytes, i) => ({
      id: objects[i],
      file: 'photos/' + objects[i],
      size: bytes.length,
      contentType: 'image/png',
    })),
  };
  const file = join(dir, 'manifest.json');
  await writeFile(file, JSON.stringify(manifest));
  const sqlite = join(dir, 'legacy.sqlite');
  const create = spawnSync(
    'python3',
    [
      '-c',
      `import sqlite3,json,sys
m=json.load(open(sys.argv[1]));c=sqlite3.connect(sys.argv[2]);c.execute('CREATE TABLE listings(id,source,payload,hidden,override)');c.execute('CREATE TABLE sources(id,checked_at,attempted_at,count,status,error)')
for r in m['listings']:c.execute('INSERT INTO listings VALUES(?,?,?,?,?)',(r['id'],r['source'],json.dumps(r['payload']),r['hidden'],json.dumps(r['override'])))
c.commit();c.close()`,
      file,
      sqlite,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(create.status, 0, create.stderr);
  const exported = join(dir, 'export');
  const exportRun = spawnSync(
    'python3',
    [
      'scripts/export-legacy.py',
      '--database',
      sqlite,
      '--output',
      exported,
      '--photos-dir',
      join(dir, 'photos'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(exportRun.status, 0, exportRun.stderr);
  assert.equal(
    (await migrateLegacy(join(exported, 'manifest.json'), { repository: repo, storage })).listings,
    1,
  );
  const remoteDir = join(dir, 'remote');
  await mkdir(remoteDir);
  const remoteManifest = join(remoteDir, 'manifest.json');
  await writeFile(
    remoteManifest,
    JSON.stringify({ ...manifest, media: manifest.media.map(({ id, file }) => ({ id, file })) }),
  );
  const legacyEnv = {
    ...process.env,
    LEGACY_S3_ENDPOINT: config.s3.endpoint,
    LEGACY_S3_BUCKET: config.bucket,
    LEGACY_S3_ACCESS_KEY: config.s3.credentials.accessKeyId,
    LEGACY_S3_SECRET_KEY: config.s3.credentials.secretAccessKey,
    LEGACY_S3_PREFIX: storage.prefix,
  };
  for (const args of [[], ['--apply'], ['--apply']]) {
    const copy = spawnSync(
      process.execPath,
      ['scripts/fetch-legacy-media.mjs', remoteManifest, ...args],
      { env: legacyEnv, encoding: 'utf8' },
    );
    assert.equal(copy.status, 0, copy.stderr);
  }
  assert.equal((await migrateLegacy(remoteManifest, { repository: repo, storage })).media, 2);
  assert.equal((await migrateLegacy(file, { repository: repo, storage })).dryRun, true);
  assert.equal((await pool.query('SELECT count(*) FROM migration_runs')).rows[0].count, '0');
  await assert.rejects(
    migrateLegacy(file, { repository: repo, storage, apply: true, stopAfter: 1 }),
    /interrupted/,
  );
  assert.ok((await storage.cleanup({ apply: true })).blocked);
  const migrated = await migrateLegacy(file, { repository: repo, storage, apply: true });
  assert.equal(migrated.idMap[id], id);
  assert.equal(migrated.status, 'complete');
  assert.equal((await repo.detail(id)).title, 'Owner correction');
  await migrateLegacy(file, { repository: repo, storage, apply: true });
  assert.equal((await repo.read()).listings.length, 9);
  await writeFile(join(dir, 'photos', objects[0]), Buffer.from('corrupt'));
  await assert.rejects(migrateLegacy(file, { repository: repo, storage }), /integrity/);
  // Reused media must survive until all references disappear; uploads and grace periods survive GC.
  await repo.importRecords([
    {
      ...row,
      id: 'reuse',
      payload: { ...row.payload, id: 'reuse', url: raw.url.replace('001/', '088/') },
    },
  ]);
  await pool.query(
    "UPDATE media SET created_at=now()-interval '2 days',lease_until=now()-interval '1 day'",
  );
  assert.deepEqual((await storage.cleanup()).candidates, []);
  const orphan = qaImage([77, 88, 99]),
    orphanId = contentHash(orphan);
  objects.push(orphanId);
  await storage.put(orphanId, orphan, 'image/png');
  assert.equal((await storage.cleanup({ apply: true })).deleted, 0);
  await pool.query(
    "UPDATE media SET created_at=now()-interval '2 days',lease_until=now()-interval '1 day',status='uploading' WHERE id=$1",
    [orphanId],
  );
  assert.equal((await storage.cleanup({ apply: true })).deleted, 0);
  await pool.query("UPDATE media SET status='ready' WHERE id=$1", [orphanId]);
  assert.deepEqual((await storage.cleanup()).candidates, [orphanId]);
  assert.equal((await storage.cleanup({ apply: true })).deleted, 1);
  assert.equal(await storage.get(orphanId), null);
  console.log(
    'P2 integration passed: SQL rollback/concurrency, identity/editorial preservation, pagination/filtering, private S3 integrity/reuse, migration dry-run/restart/checksum, safe cleanup.',
  );
} finally {
  for (const id of objects)
    await client
      .send(new DeleteObjectCommand({ Bucket: config.bucket, Key: storage.key(id) }))
      .catch(() => {});
  client.destroy();
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
  await rm(dir, { recursive: true, force: true });
}
