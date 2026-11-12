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
  for (const [value, message] of [
    ['manitoba-museum=write', /only shadow/],
    ['wag=shadow', /not available for source wag/],
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
    parser: ['2026-11-14T17:00:00.000Z'],
    extraction: ['2026-11-21T17:00:00.000Z'],
  });
  // Split sessions from one page are compared together.
  const sessions = parser.occurrences.map((o) => ({ ...parser, occurrences: [o] }));
  assert.deepEqual(compareExtraction(same, sessions), []);
  assert.equal(compareExtraction(same, [])[0].field, 'listing');
});
