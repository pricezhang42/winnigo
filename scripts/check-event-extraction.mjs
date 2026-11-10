// Repository integration against a temporary PostgreSQL schema using synthetic extraction facts.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { normalizeOccurrence } from '../lib/event-schedule.mjs';
import { applyAction } from '../lib/server/actions.mjs';
import { prepareExtractedCollection } from '../lib/server/event-extraction-integration.mjs';
import { PostgresRepository } from '../lib/server/postgres-repository.mjs';
import { serviceConfig } from './check-services.mjs';
import { examples } from './fixtures/event-extraction.mjs';

const { connectionString } = serviceConfig();
const schema = 'extraction_test_' + Date.now();
const admin = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
const repo = new PostgresRepository(pool);
const owner = { userId: 'extraction-qa-owner', role: 'owner' };

try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const migrations = new URL('../migrations/postgres/', import.meta.url);
  for (const file of (await readdir(migrations)).filter((f) => /^\d+.*\.sql$/.test(f)).sort())
    await pool.query(await readFile(new URL(file, migrations), 'utf8'));

  // Run the extraction preview through the existing import path in this temporary schema.
  const extractionSource = { id: 'qa-extracted-events', name: 'Synthetic event extraction' };
  const extractionFixture = structuredClone(examples.find((e) => e.name.startsWith('multiple')));
  const extractionContext = extractionFixture.context;
  extractionContext.source = extractionSource.id;
  const extractionValue = extractionFixture.result;
  const extractionEvent = extractionValue.events[0];
  const imageUrl = 'https://events.example.test/photos/poster.png';
  const imageQuote = 'Event poster: ' + imageUrl;
  extractionContext.documents[0].urls.push(imageUrl);
  extractionContext.documents[0].text += ' ' + imageQuote;
  extractionEvent.images = [{ url: imageUrl, kind: 'event', caption: null }];
  extractionEvent.evidence.push({
    fields: ['/images/0'],
    sourceUrl: extractionContext.pageUrl,
    quote: imageQuote,
  });
  const mediaId = 'e'.repeat(64);
  const options = {
    source: extractionSource,
    identifyEvent(url) {
      assert.equal(url, extractionContext.pageUrl);
      return { eventUrl: url, id: 'qa-extraction-parent', sourceIdentity: 'synthetic:concert' };
    },
    photos: {
      validateUrl(url) {
        assert.equal(url, imageUrl);
        return url;
      },
      read: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      async storePhoto({ bytes, contentType }) {
        await pool.query(
          "INSERT INTO media(id,object_key,content_type,size,status) VALUES($1,$2,$3,$4,'ready')",
          [mediaId, 'qa-extraction/' + mediaId, contentType, bytes.length],
        );
        return '/api/photos/' + mediaId;
      },
    },
  };
  const importPreview = async (result) => {
    assert.equal(result.completeSchedules, false);
    assert.ok(result.items.length);
    return repo.applySourceCollection(result.sourceId, result.items, {
      checkedAt: result.checkedAt,
      complete: false,
      cancelMissing: false,
      preserveHistory: true,
    });
  };
  const firstPreview = await prepareExtractedCollection(
    extractionValue,
    extractionContext,
    options,
  );
  assert.equal(firstPreview.status, 'ok');
  const [extracted] = firstPreview.items;
  extracted.occurrences[0].id = 'qa-extraction-established-slot';
  const session = extracted.occurrences[0].id;
  const history = normalizeOccurrence(
    { id: 'qa-extraction-old-day', start: '2026-10-15' },
    extracted,
  );
  extracted.occurrences.push(history);
  await importPreview(firstPreview);
  await applyAction(
    { action: 'update', id: extracted.id, title: 'Owner extraction title' },
    repo,
    owner,
  );
  await applyAction(
    { action: 'update', id: session, title: 'Owner extraction session', hidden: true },
    repo,
    owner,
  );
  const occurrenceRows = async () =>
    (
      await pool.query(
        'SELECT occurrence_id, status, start_at FROM occurrences WHERE listing_id=$1 ORDER BY occurrence_id',
        [extracted.id],
      )
    ).rows;
  const before = await occurrenceRows();
  assert.equal(before.length, extracted.occurrences.length);
  const partialValue = structuredClone(extractionValue);
  partialValue.events[0].schedule.dates.length = 1;
  for (let attempt = 0; attempt < 2; attempt++) {
    const partial = await prepareExtractedCollection(partialValue, extractionContext, {
      source: extractionSource,
      identifyEvent: options.identifyEvent,
      knownListings: await repo.knownSourceListings(extractionSource.id),
    });
    assert.equal(partial.items[0].id, extracted.id);
    assert.equal(partial.items[0].occurrences[0].id, session);
    await importPreview(partial);
    assert.deepEqual(await occurrenceRows(), before);
  }
  const parent = await repo.detail(extracted.id, { admin: true, principal: owner });
  assert.equal(parent.title, 'Owner extraction title');
  assert.equal(parent.image, '/api/photos/' + mediaId);
  assert.equal(
    (await repo.detail(session, { admin: true, principal: owner })).title,
    'Owner extraction session',
  );
  assert.equal(await repo.detail(session, { principal: owner }), null);
  const failed = await prepareExtractedCollection(null, extractionContext, options);
  assert.equal(failed.status, 'partial');
  assert.deepEqual(failed.items, []);
  assert.deepEqual(await occurrenceRows(), before);
  assert.equal(
    (await pool.query('SELECT media_id FROM listing_media WHERE listing_id=$1', [extracted.id]))
      .rows[0].media_id,
    mediaId,
  );
  console.log(
    'Extraction import preserves occurrence identities, history, owner edits and private media across partial reruns.',
  );
} finally {
  await pool.end();
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await admin.end();
  }
}
