import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  collectMusic,
  parseMusicPage,
  musicUrl,
  musicCalendarUrl,
} from '../../lib/server/manitoba-music.mjs';
const html = await readFile('scripts/fixtures/music/calendar.html', 'utf8'),
  now = '2026-10-26T12:00:00Z';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  stored = '/api/photos/' + 'c'.repeat(64);
const collect = (options = {}) =>
  collectMusic({}, now, {
    pauseMs: 0,
    fetchImpl: async (u) => new Response(u.includes('/uploads/') ? png : html),
    ...options,
  });
test('Music preserves distinct IDs, linked recurrence, DST, precise show times and unknown end times', async () => {
  const r = await collect();
  assert.equal(r.failedPages.length, 0);
  assert.equal(r.items.length, 2);
  assert.equal(r.occurrencesFound, 3);
  const series = r.items.find((e) => e.recurring);
  assert.equal(series.occurrences[0].startAt, '2026-11-01T00:00:00.000Z');
  assert.equal(series.occurrences[0].endTimeKnown, false);
  assert.equal(series.occurrences[1].startAt, '2026-11-02T01:00:00.000Z');
  assert.equal(series.occurrences[1].endAt, '2026-11-02T03:00:00.000Z');
  assert.equal(r.items[1].price, null);
  assert.notEqual(r.items[0].id, r.items[1].id);
});
test('Music validates response filters, layout, dates and safe links', () => {
  const url = musicCalendarUrl({ from: '2026-10-01' });
  assert.equal(parseMusicPage(html, url, '2026-10-01').records.length, 3);
  assert.throws(() => parseMusicPage(html, url, '2026-11-01'), /different date/);
  assert.throws(() => parseMusicPage('blocked', url), /layout/);
  assert.throws(() => parseMusicPage(html.replace('2026-10-31T', '2026-02-30T'), url), /invalid/);
  assert.throws(() => musicUrl('https://evil.test/livemusic/from:Oct+1+2026'), /Refused/);
  assert.throws(
    () => musicUrl('https://www.manitobamusic.com/uploads/organization/logo.png', 'photo'),
    /Refused/,
  );
});
test('Music geography is explicit and unknown locations stay hidden for review', async () => {
  const r = await collect({
    fetchImpl: async () =>
      new Response(
        html.replace('Winnipeg, MB', 'Vancouver, BC').replace('Winnipeg, MB', 'Unknown place'),
      ),
  });
  assert.equal(r.skippedOutsideManitoba, 1);
  assert.equal(r.locationReviewRequired, 1);
  assert.ok(r.items.some((e) => e.status === 'hidden'));
});
test('Music private photos reuse prior media and survive failed enrichment', async () => {
  let writes = 0;
  const r = await collect({
    storePhoto: async () => {
      writes++;
      return stored;
    },
  });
  assert.equal(writes, 1);
  const knownListings = new Map(r.items.map((e) => [e.id, e]));
  const repeat = await collect({
    knownListings,
    storePhoto: () => {
      throw Error('Must reuse');
    },
  });
  assert.equal(repeat.failedPages.length, 0);
  knownListings.get(r.items[0].id).sourceImages = [
    'https://www.manitobamusic.com/uploads/event/old.png',
  ];
  const fail = await collect({
    knownListings,
    storePhoto: () => {
      throw Error('Storage down');
    },
  });
  assert.equal(fail.failedPages.length, 1);
  assert.deepEqual(fail.items[0].images, [stored]);
});
test('Music page limits and later failures are partial, never inferred cancellations', async () => {
  const next =
    html + '<a href="https://www.manitobamusic.com/livemusic/from:Oct%2B1%2B2026/page:2">Next</a>';
  const partial = await collect({
    fetchImpl: async (u) =>
      u.includes('page:2') ? new Response('Down', { status: 503 }) : new Response(next),
  });
  assert.equal(partial.failedPages.length, 1);
  assert.ok(partial.items.every((e) => !e.occurrencesComplete));
  const limited = await collect({ maxPages: 1, fetchImpl: async () => new Response(next) });
  assert.equal(limited.failedPages.length, 1);
  const wrong = await collect({
    fetchImpl: async () => new Response(html.replace('found 3', 'found 9')),
  });
  assert.equal(wrong.failedPages.length, 1);
});
test('Music keeps numeric identity through slug changes and preserves explicit cancellations', async () => {
  const a = await collect();
  const changed = await collect({
    fetchImpl: async () => new Response(html.replaceAll('/show', '/renamed-show')),
  });
  assert.deepEqual(
    a.items.map((e) => e.id),
    changed.items.map((e) => e.id),
  );
  assert.deepEqual(
    a.items.flatMap((e) => e.occurrences.map((o) => o.id)),
    changed.items.flatMap((e) => e.occurrences.map((o) => o.id)),
  );
  const cancelled = await collect({
    fetchImpl: async () => new Response(html.replaceAll('Test Show', 'CANCELLED Test Show')),
  });
  assert.ok(cancelled.items.flatMap((e) => e.occurrences).some((o) => o.status === 'cancelled'));
});
