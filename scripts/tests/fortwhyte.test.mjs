import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  collectFortwhyte,
  parseFortwhyteMonth,
  fortwhyteUrl,
  FORTWHYTE_ID,
} from '../../lib/server/fortwhyte.mjs';
import { normalizeEvents, projectEvent } from '../../lib/event-schedule.mjs';
import { sources } from '../../lib/connectors.mjs';
import { SCHEDULES } from '../../lib/server/job-queue.mjs';
const oct = await readFile('scripts/fixtures/fortwhyte/october.html', 'utf8');
const nov = await readFile('scripts/fixtures/fortwhyte/november.html', 'utf8');
const source = sources.find((s) => s.id === FORTWHYTE_ID),
  now = '2026-10-26T12:00:00Z';
const photo = 'https://www.fortwhyte.org/wp-content/uploads/2026/10/synthetic.png';
const stored = '/api/photos/' + 'b'.repeat(64),
  png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const fetchImpl = async (u, options) => {
  assert.equal(options.redirect, 'error');
  return new Response(u === photo ? png : u.includes('2026-10/') ? oct : nov);
};
const collect = (options = {}) =>
  collectFortwhyte(source, now, { pauseMs: 0, fetchImpl, ...options });
test('FortWhyte shares event details, preserves separate performances and corrects cached DST offsets', async () => {
  const r = await collect();
  assert.equal(r.failedPages.length, 0);
  assert.equal(r.items.length, 2);
  assert.equal(r.occurrencesFound, 5);
  const series = r.items.find((e) => e.recurring);
  assert.equal(series.occurrences.length, 4);
  assert.equal(series.price, null);
  const winter = series.occurrences.find((o) => o.start === '2026-11-01');
  assert.equal(winter.startAt, '2026-11-01T16:30:00.000Z');
  assert.equal(winter.publishedStart, '2026-11-01T10:30:00-06:00');
  const cached = series.occurrences.find((o) => o.start === '2026-11-07');
  assert.equal(cached.startAt, '2026-11-07T16:30:00.000Z');
  assert.equal(cached.publishedStart, '2026-11-07T10:30:00-05:00');
  assert.equal(cached.status, 'cancelled');
  assert.equal(new Set(series.occurrences.map((o) => o.id)).size, 4);
  assert.equal(projectEvent(normalizeEvents(r.items, now)[0]).length, 3);
  const once = r.items.find((e) => !e.recurring);
  assert.equal(once.occurrences[0].endTimeKnown, false);
  assert.match(once.time, /7:00/);
  assert.equal(source.manualOnly, true);
  assert.equal(SCHEDULES[FORTWHYTE_ID], undefined);
  assert.equal(source.collectionTimeoutSeconds, 1800);
});
test('FortWhyte rejects malformed/wrong/overflow-truncated month pages and unsafe URLs', () => {
  for (const html of [
    'Blocked',
    oct.replace('"@graph":', '"@graph":broken'),
    oct.replace('"found_events":2', '"found_events":20'),
    oct.replace('"url_event_date":"2026-10', '"url_event_date":"2026-12'),
    oct.replace('/month/2026-11/', '/month/2026-12/'),
  ])
    assert.throws(() => parseFortwhyteMonth(html, '2026-10'));
  assert.throws(
    () => parseFortwhyteMonth(oct.replace('2026-10-31T10:30:00', '2026-02-30T10:30:00'), '2026-10'),
    /invalid/,
  );
  for (const url of [
    'https://evil.test/event/a/',
    'https://user@www.fortwhyte.org/event/a/',
    'https://www.fortwhyte.org/wp-admin/',
  ])
    assert.throws(() => fortwhyteUrl(url), /Refused/);
  assert.throws(
    () => fortwhyteUrl('https://www.fortwhyte.org/wp-content/uploads/a.svg', 'photo'),
    /Refused/,
  );
});
test('FortWhyte partial month reads keep explicit dates without claiming complete coverage', async () => {
  const r = await collect({
    fetchImpl: async (u) =>
      u.includes('2026-11/') ? new Response('Down', { status: 503 }) : new Response(oct),
  });
  assert.equal(r.failedPages.length, 1);
  assert.equal(r.items.length, 2);
  assert.ok(r.items.every((e) => !e.occurrencesComplete && !e.scheduleCoverage[0].complete));
  const firstMissing = await collect({
    fetchImpl: async (u) =>
      u.includes('2026-10/') ? new Response('Down', { status: 503 }) : new Response(nov),
  });
  assert.equal(firstMissing.pagesRead, 1);
  assert.equal(firstMissing.failedPages.length, 1);
  await assert.rejects(
    collect({ fetchImpl: async () => new Response('Down', { status: 503 }) }),
    /HTTP 503/,
  );
});
test('FortWhyte photo storage reuses private references and retains photos when enrichment fails', async () => {
  let writes = 0;
  const r = await collect({
    storePhoto: async ({ bytes, contentType }) => {
      assert.deepEqual(bytes, png);
      assert.equal(contentType, 'image/png');
      writes++;
      return stored;
    },
  });
  assert.equal(writes, 1);
  const series = r.items.find((e) => e.recurring);
  assert.deepEqual(series.images, [stored]);
  const knownListings = new Map(r.items.map((e) => [e.id, e]));
  const reused = await collect({
    knownListings,
    storePhoto: () => {
      throw Error('Must reuse');
    },
  });
  assert.equal(reused.failedPages.length, 0);
  knownListings.get(series.id).sourceImages = [
    'https://www.fortwhyte.org/wp-content/uploads/old.png',
  ];
  const failed = await collect({
    knownListings,
    storePhoto: () => {
      throw Error('Storage down');
    },
  });
  assert.equal(failed.failedPages.length, 1);
  assert.deepEqual(failed.items.find((e) => e.recurring).images, [stored]);
  assert.equal(failed.occurrencesFound, 5);
});
test('FortWhyte request bounds and explicit empty months fail safely', async () => {
  const limit = await collect({ maxRequests: 1 });
  assert.equal(limit.pagesRead, 1);
  assert.equal(limit.failedPages.length, 1);
  const empty = '<div data-view="month">No events scheduled</div>';
  const r = await collect({ fetchImpl: async () => new Response(empty) });
  assert.equal(r.allowEmpty, true);
  assert.equal(r.items.length, 0);
  const aborted = AbortSignal.abort();
  await assert.rejects(collect({ signal: aborted }), /abort/i);
});

test('FortWhyte caps gallery downloads and rejects oversized or non-image photo responses', async () => {
  const images = Array.from({ length: 4 }, (_, i) => photo.replace('synthetic', `synthetic${i}`));
  const multi = oct.replace(
    '"image":{"contentUrl":"' + photo + '"}',
    '"image":' + JSON.stringify(images),
  );
  let writes = 0;
  const capped = await collect({
    fetchImpl: async (u) =>
      new Response(u.includes('/month/') ? (u.includes('2026-10/') ? multi : nov) : png),
    storePhoto: async () => {
      writes++;
      return stored;
    },
  });
  assert.equal(writes, 3);
  assert.equal(capped.items.find((e) => e.recurring).images.length, 3);
  for (const bad of [Buffer.from('<html>blocked</html>'), Buffer.alloc(8 * 1024 * 1024 + 1)]) {
    const result = await collect({
      fetchImpl: async (u) => new Response(u === photo ? bad : u.includes('2026-10/') ? oct : nov),
      storePhoto: async () => {
        throw Error('Invalid bytes must not reach storage');
      },
    });
    assert.equal(result.failedPages.length, 1);
    assert.equal(result.items.find((e) => e.recurring).images.length, 0);
  }
  const prior = capped.items.find((e) => e.recurring);
  const partial = await collect({
    knownListings: new Map([[prior.id, prior]]),
    fetchImpl: async (u) =>
      u.includes('2026-10/') ? new Response('Down', { status: 503 }) : new Response(nov),
    storePhoto: () => {
      throw Error('No new photo metadata');
    },
  });
  assert.deepEqual(partial.items[0].images, prior.images);
});
