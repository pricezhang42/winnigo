import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareExtraction,
  configureExtractionRollout,
  readExtractionRollout,
} from '../../lib/server/extraction-rollout.mjs';

const env = (sources, provider = 'openai') => ({
  WINNIGO_EXTRACTION_SOURCES: sources,
  WINNIGO_EXTRACTION_PROVIDER: provider,
});

test('rollout is off by default and only accepts shadow mode for supported sources', () => {
  assert.equal(readExtractionRollout({}).size, 0);
  assert.equal(readExtractionRollout({ WINNIGO_EXTRACTION_SOURCES: ' ' }).size, 0);
  assert.deepEqual(
    [...readExtractionRollout(env('manitoba-museum=shadow'))],
    [['manitoba-museum', 'shadow']],
  );
  assert.equal(readExtractionRollout(env('wag=shadow')).get('wag'), 'shadow');
  assert.equal(readExtractionRollout(env('wag=write')).get('wag'), 'write');
  for (const [value, message] of [
    ['manitoba-museum=write', /only for wag/],
    ['unknown=shadow', /not available for source unknown/],
    ['manitoba-museum', /source=shadow/],
    ['manitoba-museum=shadow=x', /source=shadow/],
    ['manitoba-museum=shadow,manitoba-museum=shadow', /listed twice/],
  ])
    assert.throws(() => readExtractionRollout(env(value)), message);
  assert.throws(
    () => readExtractionRollout(env('manitoba-museum=shadow', 'disabled')),
    /requires WINNIGO_EXTRACTION_PROVIDER/,
  );
  assert.throws(
    () =>
      configureExtractionRollout({
        ...env('manitoba-museum=shadow'),
        WINNIGO_EXTRACTION_SHADOW_MAX_MS: '10',
      }),
    /SHADOW_MAX_MS/,
  );
});

test('sources outside the rollout get no shadow and create no provider service', () => {
  let created = 0;
  const rollout = configureExtractionRollout(env('manitoba-museum=shadow'), {
    createService: () => {
      created++;
      return { model: 'm', extractionVersion: 'v', extract: async () => ({}) };
    },
  });
  assert.equal(rollout.forSource({ id: 'fortwhyte' }, { pool: {}, checkedAt: '' }), null);
  assert.equal(created, 0);
  assert.ok(rollout.forSource({ id: 'manitoba-museum' }, { pool: {}, checkedAt: '' }));
  assert.equal(created, 1);
});

test('comparison reports title, venue, occurrence, run and price differences only', () => {
  const parser = {
    title: 'Worlds of Ice',
    venue: 'Planetarium',
    price: 12,
    occurrences: [
      { start: '2026-11-07', startAt: '2026-11-07T17:00:00.000Z' },
      { start: '2026-11-14', startAt: '2026-11-14T17:00:00.000Z' },
    ],
  };
  const same = {
    ...parser,
    title: ' worlds  of ICE ',
    occurrences: [...parser.occurrences].reverse(),
    price: null,
  };
  assert.deepEqual(compareExtraction(same, [parser]), []);
  const different = {
    title: 'Worlds of Ice',
    venue: 'Manitoba Museum',
    price: 15,
    runDates: { start: '2026-11-01', endMonth: '2027-04' },
    occurrences: [
      { start: '2026-11-07', startAt: '2026-11-07T17:00:00.000Z' },
      { start: '2026-11-21', startAt: '2026-11-21T17:00:00.000Z' },
    ],
  };
  assert.deepEqual(
    compareExtraction(different, [parser]).map((d) => d.field),
    ['venue', 'occurrences', 'runDates', 'price'],
  );
  assert.deepEqual(compareExtraction(different, [parser])[1], {
    field: 'occurrences',
    parser: ['2026-11-07T17:00:00.000Z', '2026-11-14T17:00:00.000Z'],
    extraction: ['2026-11-21T17:00:00.000Z'],
  });
  // A detail page that lists fewer sessions than the calendar is coverage, not a difference.
  const focused = { ...parser, occurrences: [parser.occurrences[1]] };
  assert.deepEqual(compareExtraction(focused, [parser]), []);
  // No shared session at all is a difference.
  const none = { ...parser, occurrences: [] };
  assert.equal(compareExtraction(none, [parser])[0].field, 'occurrences');
  // Split sessions from one page are compared together.
  const sessions = parser.occurrences.map((o) => ({ ...parser, occurrences: [o] }));
  assert.deepEqual(compareExtraction(same, sessions), []);
  assert.equal(compareExtraction(same, [])[0].field, 'listing');
});

test('write preserves collector media/cancellation and falls back on provider/budget/time/preparation failures', async () => {
  const { createExtractionShadow } = await import('../../lib/server/extraction-rollout.mjs');
  const { single, context } = await import('../fixtures/event-extraction.mjs');
  const source = { id: 'wag', name: 'WAG–Qaumajuq' };
  const html = '<main>QA Concert. November 20, 2026 at 7 PM. QA Hall.</main>';
  const parsed = {
    id: 'write-page',
    source: 'wag',
    url: context.pageUrl,
    title: 'Parser',
    venue: 'QA Hall',
    images: ['/api/photos/' + 'a'.repeat(64)],
    image: '/api/photos/' + 'a'.repeat(64),
    sourceImages: ['https://events.example.test/photo.jpg'],
    status: 'cancelled',
    availability: 'sold-out',
    price: 12,
  };
  const run = async (extract, extra = {}) => {
    const hook = createExtractionShadow({
      source,
      pool: { query: async () => ({ rows: [] }) },
      checkedAt: context.checkedAt,
      maxMs: 1000,
      mode: 'write',
      extractor: { extract },
    });
    hook.capture({ url: context.pageUrl, html, id: parsed.id, ...extra });
    return hook.finish({ runId: null, items: [parsed] });
  };
  const result = await run(async () => ({ result: single }));
  assert.equal(result.counts.imported, 1);
  assert.deepEqual(result.items[0].images, parsed.images);
  assert.deepEqual(result.items[0].sourceImages, parsed.sourceImages);
  assert.equal(result.items[0].status, 'cancelled');
  assert.equal(result.items[0].availability, 'sold-out');
  assert.equal(result.items[0].price, 12);
  for (const code of ['provider_failed', 'budget_exceeded', 'timeout', 'aborted']) {
    const fallback = await run(async () => {
      throw Object.assign(Error(code), { code });
    });
    assert.deepEqual(fallback.items, [parsed]);
    assert.equal(fallback.counts.imported, 0);
    assert.equal(fallback.counts.fallback, 1);
  }
  const held = await run(async () => ({ result: { event: null } }));
  assert.deepEqual(held.items, [parsed]);
  const unprepared = await run(
    async () => {
      throw Error('must not call');
    },
    { html: '<main></main>' },
  );
  assert.deepEqual(unprepared.items, [parsed]);
});
