// Repository integration against a temporary PostgreSQL schema using synthetic extraction facts.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { normalizeOccurrence } from '../lib/event-schedule.mjs';
import { applyAction } from '../lib/server/actions.mjs';
import { cacheEventExtraction } from '../lib/server/cached-event-extraction.mjs';
import { createEventExtractionService } from '../lib/server/event-extraction-service.mjs';
import { prepareExtractedCollection } from '../lib/server/event-extraction-integration.mjs';
import { runCollection } from '../lib/server/collection.mjs';
import {
  createExtractionShadow,
  configureExtractionRollout,
} from '../lib/server/extraction-rollout.mjs';
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

// Write mode imports through the same repository boundary and falls back per page.
async function checkWrite() {
  const source = { id: 'wag', name: 'WAG–Qaumajuq' };
  const url = (slug) => `https://www.wag.ca/event/${slug}/`;
  const parsed = ['accepted', 'withheld', 'broken', 'unprepared'].map((slug) => ({
    id: 'qa-write-' + slug,
    source: 'wag',
    sourceName: source.name,
    url: url(slug),
    title: 'Parser ' + slug,
    venue: 'Parser Hall',
    type: 'Event',
    category: 'Arts & culture',
    schedule: 'event',
    start: '2026-11-20',
    end: '2026-11-20',
    status: 'active',
    price: null,
  }));
  const collect = async (source, checkedAt, options) => {
    for (const slug of ['accepted', 'withheld', 'broken', 'unprepared', 'new'])
      options.onEventPage?.({
        url: url(slug),
        id: 'qa-write-' + slug,
        html:
          slug === 'unprepared'
            ? '<div></div>'
            : '<main>QA Concert. November 20, 2026 at 7 PM. QA Hall.</main>',
      });
    return parsed.map((item) => ({ ...item, checkedAt }));
  };
  const extractor = {
    async extract(context) {
      if (context.pageUrl === url('broken')) throw Error('provider unavailable');
      return { result: context.pageUrl === url('withheld') ? { event: null } : single };
    },
  };
  const extraction = {
    forSource: (source, { pool, checkedAt }) =>
      createExtractionShadow({
        source,
        pool,
        checkedAt,
        extractor,
        maxMs: 10000,
        mode: 'write',
      }),
  };
  const run = (id, extra = {}) =>
    runCollection(
      'wag',
      { id, data: { trigger: 'manual' } },
      {
        pool,
        repository: repo,
        collect,
        extraction,
        now: () => context.checkedAt,
        ...extra,
      },
    );
  const first = await run('qa-write-1');
  assert.equal(first.status, 'ok');
  assert.equal(first.counts.extraction.imported, 2);
  assert.equal(first.counts.extraction.fallback, 3);
  let saved = await repo.knownSourceListings('wag');
  for (const slug of ['accepted', 'new']) {
    assert.equal(saved.get('qa-write-' + slug).title, 'QA Concert');
    assert.equal(saved.get('qa-write-' + slug).provenance, 'event-extraction');
  }
  for (const slug of ['withheld', 'broken', 'unprepared'])
    assert.equal(saved.get('qa-write-' + slug).title, 'Parser ' + slug);
  await applyAction(
    { action: 'update', id: 'qa-write-accepted', title: 'Owner write title' },
    repo,
    owner,
  );
  const before = await pool.query(
    "SELECT occurrence_id FROM occurrences WHERE listing_id='qa-write-accepted'",
  );
  const second = await run('qa-write-2');
  assert.equal(second.status, 'ok');
  assert.equal(
    (await repo.detail('qa-write-accepted', { admin: true, principal: owner })).title,
    'Owner write title',
  );
  assert.deepEqual(
    (await pool.query("SELECT occurrence_id FROM occurrences WHERE listing_id='qa-write-accepted'"))
      .rows,
    before.rows,
  );
  // Failure to initialize the provider keeps ordinary parser imports available.
  const broken = await run('qa-write-3', {
    extraction: {
      forSource() {
        throw Error('unavailable');
      },
    },
  });
  assert.equal(broken.status, 'ok');
  assert.equal(broken.counts.extraction, undefined);
  saved = await repo.knownSourceListings('wag');
  assert.ok(saved.has('qa-write-new'));
  assert.equal(
    (await repo.detail('qa-write-accepted', { admin: true, principal: owner })).title,
    'Owner write title',
  );
  console.log(
    'WAG write imports accepted pages, preserves owner/session identity, and falls back per page and on provider initialization failure.',
  );
}

// Shadow mode runs a real collection: parser listings are saved unchanged and each fetched event
// page is extracted (stubbed provider), mapped and compared, with failures kept out of the run.
async function checkShadow() {
  let generations = 0;
  const createService = () =>
    createEventExtractionService(
      {
        model: 'qa-shadow-model',
        extractionVersion: 'shadow-v1',
        countInput: async () => 100,
        async generate() {
          generations++;
          return {
            status: 'completed',
            text: JSON.stringify(single),
            usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, reasoningTokens: 5 },
          };
        },
      },
      { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxOutputTokens: 60, budgetUsd: 0.01 },
    );
  const env = {
    WINNIGO_EXTRACTION_SOURCES: 'manitoba-museum=shadow',
    WINNIGO_EXTRACTION_PROVIDER: 'openai',
  };
  const extraction = configureExtractionRollout(env, { createService });
  const page = (slug, body) => ({
    url: `https://manitobamuseum.ca/event/${slug}/`,
    html: `<html><body><nav>Menu</nav><div id="tribe-events-content">${body}</div></body></html>`,
    selector: '#tribe-events-content',
    id: 'qa-shadow-' + slug,
    itemIds: ['qa-shadow-' + slug],
  });
  const listing = (slug, venue) => ({
    id: 'qa-shadow-' + slug,
    source: 'manitoba-museum',
    title: 'QA Concert',
    url: `https://manitobamuseum.ca/event/${slug}/`,
    type: 'Event',
    category: 'Arts & Culture',
    venue,
    neighbourhood: 'Downtown',
    start: '2026-11-20',
    end: '2026-11-20',
    startAt: '2026-11-21T01:00:00.000Z',
    schedule: 'event',
    description: 'Synthetic shadow listing',
    sourceName: 'Manitoba Museum',
    price: null,
    family: false,
    indoor: true,
    image: '',
    status: 'active',
  });
  const text = '<h1>QA Concert</h1><p>QA Concert. November 20, 2026 at 7 PM. QA Hall.</p>';
  const parsed = [
    listing('agree', 'QA Hall'),
    listing('differ', 'Another Hall'),
    listing('empty', 'QA Hall'),
  ];
  const collect = async (source, checkedAt, options) => {
    options.onEventPage?.(page('agree', text));
    options.onEventPage?.(page('differ', text));
    options.onEventPage?.(page('empty', ''));
    return parsed.map((item) => ({ ...item, checkedAt }));
  };
  const run = (id) =>
    runCollection(
      'manitoba-museum',
      { id, data: { trigger: 'manual' } },
      { pool, repository: repo, collect, now: () => context.checkedAt, extraction },
    );
  const first = await run('qa-shadow-1');
  assert.equal(first.status, 'ok');
  assert.deepEqual(
    { ...first.counts.extraction, estimatedCostUsd: undefined },
    {
      mode: 'shadow',
      pages: 3,
      agree: 1,
      differ: 1,
      withheld: 0,
      failed: 1,
      skipped: 0,
      cacheHits: 0,
      estimatedCostUsd: undefined,
    },
  );
  assert.ok(first.counts.extraction.estimatedCostUsd > 0);
  const rows = (
    await pool.query(
      'SELECT page_url, outcome, reason, differences, extracted, raw FROM event_extraction_comparisons ORDER BY page_url',
    )
  ).rows;
  assert.deepEqual(
    rows.map((r) => [r.page_url.split('/').at(-2), r.outcome, r.reason]),
    [
      ['agree', 'agree', null],
      ['differ', 'differ', 'venue'],
      ['empty', 'failed', 'preparation-failed'],
    ],
  );
  // Only the row a person needs to diagnose keeps the model output.
  assert.deepEqual(rows[1].raw, single);
  assert.equal(rows[0].raw, null);
  assert.equal(rows[2].raw, null);
  assert.deepEqual(rows[1].differences, [
    { field: 'venue', parser: 'Another Hall', extraction: 'QA Hall' },
  ]);
  // Listings come only from the parser; nothing records extraction provenance.
  const saved = await repo.knownSourceListings('manitoba-museum');
  assert.equal(saved.get('qa-shadow-differ').venue, 'Another Hall');
  assert.ok([...saved.values()].every((item) => item.provenance !== 'event-extraction'));
  const runNote = (await pool.query("SELECT error FROM collection_runs WHERE job_id='qa-shadow-1'"))
    .rows[0].error;
  assert.match(runNote, /Extraction shadow: 1\/3 page\(s\) agree, 1 differ, 1 failed/);

  // The next run reuses cached extractions and spends nothing.
  const second = await run('qa-shadow-2');
  assert.equal(second.counts.extraction.cacheHits, 2);
  assert.equal(second.counts.extraction.estimatedCostUsd, 0);
  assert.equal(generations, 2);

  // A failing extraction never fails the collection.
  const broken = configureExtractionRollout(env, {
    createService: () => {
      throw Error('provider unavailable');
    },
  });
  const failed = await runCollection(
    'manitoba-museum',
    { id: 'qa-shadow-3', data: { trigger: 'manual' } },
    { pool, repository: repo, collect, now: () => context.checkedAt, extraction: broken },
  );
  assert.equal(failed.status, 'ok');
  assert.equal(failed.counts.extraction, undefined);
  assert.match(
    (await pool.query("SELECT error FROM collection_runs WHERE job_id='qa-shadow-3'")).rows[0]
      .error,
    /Extraction shadow unavailable: provider unavailable/,
  );
  console.log(
    'Extraction shadow mode compares fetched pages with parser listings, reuses the cache and never changes listings or fails collection.',
  );
}

try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const migrations = new URL('../migrations/postgres/', import.meta.url);
  for (const file of (await readdir(migrations)).filter((f) => /^\d+.*\.sql$/.test(f)).sort())
    await pool.query(await readFile(new URL(file, migrations), 'utf8'));

  await checkCache();
  await checkShadow();
  await checkWrite();

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
