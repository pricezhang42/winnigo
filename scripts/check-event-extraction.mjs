// Repository integration against a temporary PostgreSQL schema using synthetic extraction facts.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { normalizeOccurrence } from '../lib/event-schedule.mjs';
import { applyAction } from '../lib/server/actions.mjs';
import { cacheEventExtraction } from '../lib/server/cached-event-extraction.mjs';
import { createEventExtractionService } from '../lib/server/event-extraction-service.mjs';
import { prepareExtractedCollection } from '../lib/server/event-extraction-integration.mjs';
import { PostgresRepository } from '../lib/server/postgres-repository.mjs';
import { serviceConfig } from './check-services.mjs';
import { context, examples, single } from './fixtures/event-extraction.mjs';

const { connectionString } = serviceConfig();
const schema = 'extraction_test_' + Date.now();
const admin = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
const repo = new PostgresRepository(pool);
const owner = { userId: 'extraction-qa-owner', role: 'owner' };

async function checkCache() {
  let calls = 0;
  const service = (model = 'qa-model', extractionVersion = 'v1', options = {}) =>
    createEventExtractionService(
      {
        model,
        extractionVersion,
        countInput: async () => 100,
        async generate() {
          calls++;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            status: 'completed',
            text: JSON.stringify(options.result ?? single),
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              cachedInputTokens: 20,
              reasoningTokens: 15,
            },
          };
        },
      },
      {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        maxOutputTokens: 60,
        budgetUsd: options.budget ?? 0.01,
      },
    );
  const cache = cacheEventExtraction(pool, service());
  const [a, b] = await Promise.all([
    cache.extract(context),
    cacheEventExtraction(pool, service()).extract(context),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual([a.cacheHit, b.cacheHit].sort(), [false, true]);
  assert.deepEqual(a.result, single);
  assert.deepEqual(b.result, single);
  const rechecked = { ...context, checkedAt: '2026-11-08T18:00:00Z' };
  const hit = await cache.extract(rechecked);
  assert.equal(hit.cacheHit, true);
  assert.equal(hit.estimatedCostUsd, 0);
  assert.equal(hit.usage.inputTokens, 0);
  assert.equal(cache.budget().accountedUsd, a.estimatedCostUsd);

  const changes = structuredClone(context);
  changes.documents[0].text += ' An updated public notice.';
  assert.equal((await cache.extract(changes)).cacheHit, false);
  assert.equal(
    (await cacheEventExtraction(pool, service('new-model')).extract(context)).cacheHit,
    false,
  );
  assert.equal(
    (await cacheEventExtraction(pool, service('qa-model', 'v2')).extract(context)).cacheHit,
    false,
  );
  const nextWindow = {
    ...context,
    checkedAt: '2026-12-01T18:00:00Z',
    window: { from: '2026-12-01', to: '2027-01-31' },
  };
  assert.equal((await cache.extract(nextWindow)).cacheHit, false);

  // Invalid output and denied reservations leave a usage record without a cache entry.
  const invalid = cacheEventExtraction(pool, service('bad-model', 'v1', { result: {} }));
  await assert.rejects(invalid.extract(context), { code: 'invalid_extraction' });
  await assert.rejects(invalid.extract(context), { code: 'invalid_extraction' });
  const limited = cacheEventExtraction(pool, service('qa-model', 'v1', { budget: 0.0001 }));
  assert.equal((await limited.extract(context)).cacheHit, true);
  await assert.rejects(limited.extract({ ...context, source: 'qa-budget-miss' }), {
    code: 'budget_exceeded',
  });
  assert.equal(limited.budget().accountedUsd, 0);
  assert.equal(calls, 7);

  const { rows } = await pool.query(
    'SELECT cache_key, outcome, error_code, metrics FROM event_extraction_usage ORDER BY id',
  );
  assert.equal(rows.filter((row) => row.outcome === 'ok').length, 5);
  assert.equal(rows.filter((row) => row.outcome === 'hit').length, 3);
  assert.deepEqual(
    rows.filter((row) => row.outcome === 'error').map((row) => row.error_code),
    ['invalid_extraction', 'invalid_extraction', 'budget_exceeded'],
  );
  const generated = rows.find((row) => row.outcome === 'ok').metrics;
  assert.equal(generated.usage.reasoningTokens, 15);
  assert.equal(generated.usage.cachedInputTokens, 20);
  assert.equal(generated.estimatedCostUsd, 0.0002);
  assert.equal(generated.attempts[0].usage.outputTokens, 50);
  assert.ok(generated.durationMs >= 0);
  assert.equal(rows[0].cache_key, rows[1].cache_key);

  // Revalidate a saved result before use and regenerate a stale entry.
  await pool.query("UPDATE event_extraction_cache SET result = '{}' WHERE cache_key=$1", [
    rows[0].cache_key,
  ]);
  assert.equal((await cache.extract(context)).cacheHit, false);
  assert.equal((await cache.extract(context)).cacheHit, true);
  assert.equal(calls, 8);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM event_extraction_cache')).rows[0].n,
    5,
  );
  console.log(
    'Extraction cache and usage survive repeated and concurrent requests, failures and version changes.',
  );
}

try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const migrations = new URL('../migrations/postgres/', import.meta.url);
  for (const file of (await readdir(migrations)).filter((f) => /^\d+.*\.sql$/.test(f)).sort())
    await pool.query(await readFile(new URL(file, migrations), 'utf8'));

  await checkCache();

  // Run the extraction preview through the existing import path in this temporary schema.
  const extractionSource = { id: 'qa-extracted-events', name: 'Synthetic event extraction' };
  const extractionFixture = structuredClone(examples.find((e) => e.name.startsWith('multiple')));
  const extractionContext = extractionFixture.context;
  extractionContext.source = extractionSource.id;
  const extractionValue = extractionFixture.result;
  const extractionEvent = extractionValue.event;
  const imageUrl = 'https://events.example.test/photos/poster.png';
  extractionContext.documents[0].urls.push(imageUrl);
  extractionEvent.imageUrls = [imageUrl];
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
  partialValue.event.schedule.dates.length = 1;
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
