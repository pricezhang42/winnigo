// P2 integration check (npm run check:p2): runs migrations in a temporary PostgreSQL schema and
// S3 prefix, then exercises imports, search, overrides and private media.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { readFile, readdir } from 'node:fs/promises';
import { serviceConfig } from './check-services.mjs';
import { PostgresRepository, documentFor } from '../lib/server/postgres-repository.mjs';
import { S3Storage, contentHash } from '../lib/server/s3-storage.mjs';
import { qaImage } from '../lib/server/qa-image.mjs';
import { applyAction } from '../lib/server/actions.mjs';
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
const objects = [];
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const migrationFixtures = [
    {
      id: 'typed-full',
      source: 'typed-fixture',
      title: 'Source title',
      description: null,
      type: 'Activity',
      category: 'Arts & culture',
      venue: 'Synthetic Hall',
      url: 'https://example.test/typed-full',
      price: 25,
      family: false,
      indoor: true,
      status: 'active',
      start: '2026-05-01',
      schedule: 'series',
      uncertainty: { closing: 'month only' },
      originalWording: 'Until April 2027',
    },
    {
      id: 'typed-minimal',
      source: 'typed-fixture',
      title: 'Minimal source',
      url: 'https://example.test/typed-minimal',
    },
  ];
  for (const file of (await readdir('migrations/postgres'))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    await pool.query(await readFile('migrations/postgres/' + file, 'utf8'));
  // Typed columns round-trip the source contract: explicit nulls stay, absent keys stay absent.
  const migrationOverride = { title: 'Owner title', description: '', price: null };
  await repo.importRecords(
    migrationFixtures.map((payload) => ({
      id: payload.id,
      source: payload.source,
      payload,
      hidden: false,
      override: payload.id === 'typed-full' ? migrationOverride : {},
    })),
  );
  for (const expected of migrationFixtures) {
    const row = (
      await pool.query(
        'SELECT payload,document,metadata,price,end_date FROM listing_records WHERE id=$1',
        [expected.id],
      )
    ).rows[0];
    assert.deepEqual(row.payload, expected);
    assert.deepEqual(
      row.document,
      JSON.parse(
        JSON.stringify(
          documentFor({
            id: expected.id,
            payload: expected,
            override: expected.id === 'typed-full' ? migrationOverride : {},
            hidden: false,
          }),
        ),
      ),
    );
    assert.equal(row.metadata.title, undefined);
    assert.equal(row.end_date, null);
    if (expected.id === 'typed-full') {
      assert.equal(row.price, '25');
      assert.equal(row.document.price, null);
      assert.equal(row.document.description, '');
    } else {
      assert.equal('price' in row.payload, false);
      assert.equal('description' in row.payload, false);
    }
  }
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='listings' AND column_name IN ('payload','document')",
        [schema],
      )
    ).rowCount,
    0,
  );
  await pool.query(
    'UPDATE listing_overrides SET fields=fields||\'{"title":"Live correction","price":0}\'::jsonb WHERE listing_id=\'typed-full\'',
  );
  assert.equal((await repo.detail('typed-full', { admin: true })).title, 'Live correction');
  assert.equal(
    (await repo.search({ query: 'Live correction', quick: 'Free', admin: true })).total,
    1,
  );
  assert.equal(
    (await pool.query("SELECT title FROM listings WHERE id='typed-full'")).rows[0].title,
    'Source title',
  );
  await assert.rejects(
    pool.query("UPDATE listings SET price=-1 WHERE id='typed-full'"),
    /listing_price_valid/,
  );
  await assert.rejects(
    pool.query("UPDATE listings SET end_date='2026-04-30' WHERE id='typed-full'"),
    /listing_dates_order/,
  );
  const roundTrip = {
    ...migrationFixtures[1],
    id: 'typed-roundtrip',
    venue: 'Synthetic Hall',
    price: null,
    constructor: 'source metadata',
  };
  await repo.importRecords([
    { id: roundTrip.id, source: roundTrip.source, payload: roundTrip, hidden: false, override: {} },
  ]);
  const roundTripRow = (
    await pool.query('SELECT payload,metadata FROM listing_source_records WHERE id=$1', [
      roundTrip.id,
    ])
  ).rows[0];
  assert.equal(roundTripRow.payload.price, null);
  assert.equal('description' in roundTripRow.payload, false);
  assert.equal(roundTripRow.metadata.constructor, 'source metadata');
  await pool.query(
    "DELETE FROM audit_records WHERE listing_id IN (SELECT id FROM listings WHERE source='typed-fixture')",
  );
  await pool.query("DELETE FROM listings WHERE source='typed-fixture'");
  await pool.query("DELETE FROM sources WHERE id='typed-fixture'");
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
  // A dated listing matches only its own dates; undated listings never match a date filter.
  await repo.importRecords([
    {
      id: 'dated',
      source: 'calendar',
      hidden: false,
      override: {},
      payload: {
        id: 'dated',
        source: 'calendar',
        title: 'Dated outing',
        url: 'https://example.com/dated',
        start: '2099-06-01',
        end: '2099-06-02',
        status: 'active',
        schedule: 'event',
      },
    },
  ]);
  assert.deepEqual(
    (await repo.search({ date: '2099-06-02' })).items.map((item) => item.id),
    ['dated'],
  );
  assert.equal((await repo.search({ date: '2099-06-03' })).total, 0);
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
    'P2 integration passed: typed listing round trip/null precision/live overrides, SQL rollback/concurrency, identity/editorial preservation, pagination/filtering/dates, private S3 integrity/reuse, safe cleanup.',
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
}
