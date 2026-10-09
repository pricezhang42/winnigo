// Parser regression tests against saved copies of the real source pages (scripts/fixtures/pages).
// A failure here after refreshing a fixture means the site's layout changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  collectSourcePages,
  monthPageUrls,
  numberedPageUrl,
  parsePlaces,
  parseSource,
  sources,
} from '../../lib/connectors.mjs';
import { applyPoolClosures, parseFreeSwim, poolDirectoryUrl } from '../../lib/free-swim.mjs';
import { invalidReason } from '../../lib/server/collection.mjs';

const CHECKED_AT = '2026-10-08T12:00:00Z';
const page = (name) =>
  readFileSync(new URL(`../fixtures/pages/${name}.html`, import.meta.url), 'utf8');
const source = (id) => sources.find((candidate) => candidate.id === id);

// Listings each saved page yields, and one listing that must be read correctly.
const EXPECTED = [
  ['forks', 'forks-2026-10', 3],
  ['forks', 'forks-2026-11', 6],
  ['forks', 'forks-2026-12', 2],
  ['park', 'park-page-1', 9],
  ['park', 'park-page-2', 11],
  ['park', 'park-page-3', 11],
  ['manitoba', 'manitoba-page-1', 18],
  ['manitoba', 'manitoba-page-2', 19],
];

test('saved event pages parse to the expected, valid listings', () => {
  for (const [id, name, count] of EXPECTED) {
    const items = parseSource(id, page(name), CHECKED_AT);
    assert.equal(items.length, count, name);
    for (const item of items) {
      assert.equal(invalidReason(item), null, `${name}: ${item.title}`);
      assert.equal(item.source, id);
      assert.match(item.id, new RegExp('^' + id + '-'));
    }
  }
  const [first] = parseSource('forks', page('forks-2026-10'), CHECKED_AT);
  assert.equal(first.title, 'Anne Mulaire Pop-Up Shop');
  assert.equal(first.url, 'https://www.theforks.com/events/calendar-of-events/event/1314');
  assert.equal(first.start, '2026-10-08');
  assert.equal(first.end, '2026-10-11');
  assert.equal(first.time, '10:00 AM - 6:00 PM');
  // Travel Manitoba lists the whole province; only Winnipeg events are kept.
  for (const item of parseSource('manitoba', page('manitoba-page-1'), CHECKED_AT))
    assert.match(item.address, /Winnipeg/i);
});

test('saved places and free-swim pages parse to the expected listings', () => {
  const places = parsePlaces(page('forks-attractions'), CHECKED_AT);
  assert.equal(places.length, 26);
  assert.ok(places.every((place) => invalidReason(place) === null));
  const sessions = applyPoolClosures(
    parseFreeSwim(page('free-swim'), CHECKED_AT),
    page('indoor-pools'),
  );
  assert.equal(sessions.length, 291);
  assert.ok(sessions.every((session) => invalidReason(session) === null));
  assert.ok(sessions.every((session) => session.source === 'winnipeg-free-swim'));
});

test('pagination follows only the pages each site links to', () => {
  assert.equal(
    numberedPageUrl(source('park'), page('park-page-1'), 2),
    'https://www.assiniboinepark.ca/events?page=2',
  );
  assert.equal(numberedPageUrl(source('park'), page('park-page-3'), 4), null);
  assert.equal(
    numberedPageUrl(source('manitoba'), page('manitoba-page-2'), 3),
    'https://www.travelmanitoba.com/events/?page=3',
  );
  assert.equal(numberedPageUrl(source('manitoba'), page('manitoba-page-1'), 12), null);
  assert.deepEqual(monthPageUrls(source('forks'), CHECKED_AT, 2), [
    'https://www.theforks.com/events/calendar-of-events/list/2026/11',
    'https://www.theforks.com/events/calendar-of-events/list/2026/12',
  ]);
  // Month lists roll over the year in Winnipeg time (Dec 31, 23:00 local is still December).
  assert.deepEqual(monthPageUrls(source('forks'), '2027-01-01T05:00:00Z', 2), [
    'https://www.theforks.com/events/calendar-of-events/list/2027/01',
    'https://www.theforks.com/events/calendar-of-events/list/2027/02',
  ]);
});

// Serves saved pages by URL; unknown URLs fail like an unavailable page.
function savedSite(pages) {
  const requested = [];
  const fetchPage = async (url) => {
    requested.push(url);
    if (!(url in pages)) throw Error('Source returned HTTP 503');
    return page(pages[url]);
  };
  return { fetchPage, requested };
}

test('collecting a source reads every linked page and merges listings', async () => {
  const park = savedSite({
    'https://www.assiniboinepark.ca/events': 'park-page-1',
    'https://www.assiniboinepark.ca/events?page=2': 'park-page-2',
    'https://www.assiniboinepark.ca/events?page=3': 'park-page-3',
  });
  let result = await collectSourcePages(source('park'), CHECKED_AT, {
    fetchPage: park.fetchPage,
    pauseMs: 0,
  });
  assert.equal(result.pagesRead, 3);
  assert.deepEqual(result.failedPages, []);
  assert.equal(result.items.length, 25);
  assert.equal(new Set(result.items.map((item) => item.url)).size, 25);
  assert.equal(park.requested.length, 3); // page 3 links to no page 4

  const forks = savedSite({
    'https://www.theforks.com/events/calendar-of-events': 'forks-2026-10',
    'https://www.theforks.com/events/calendar-of-events/list/2026/11': 'forks-2026-11',
    'https://www.theforks.com/events/calendar-of-events/list/2026/12': 'forks-2026-12',
  });
  result = await collectSourcePages(source('forks'), CHECKED_AT, {
    fetchPage: forks.fetchPage,
    pauseMs: 0,
  });
  assert.equal(result.pagesRead, 3);
  assert.equal(result.items.length, 9);

  // Page 3 is unavailable: the first two pages are kept and the gap is reported.
  const manitoba = savedSite({
    'https://www.travelmanitoba.com/events/': 'manitoba-page-1',
    'https://www.travelmanitoba.com/events/?page=2': 'manitoba-page-2',
  });
  result = await collectSourcePages(source('manitoba'), CHECKED_AT, {
    fetchPage: manitoba.fetchPage,
    pauseMs: 0,
  });
  assert.equal(result.pagesRead, 2);
  assert.equal(result.failedPages.length, 1);
  assert.equal(result.failedPages[0].url, 'https://www.travelmanitoba.com/events/?page=3');
  assert.equal(result.items.length, 35);

  // The first page failing is a failed run.
  await assert.rejects(
    collectSourcePages(source('park'), CHECKED_AT, {
      fetchPage: savedSite({}).fetchPage,
      pauseMs: 0,
    }),
    /HTTP 503/,
  );

  const swim = savedSite({
    [source('winnipeg-free-swim').url]: 'free-swim',
    [poolDirectoryUrl]: 'indoor-pools',
  });
  result = await collectSourcePages(source('winnipeg-free-swim'), CHECKED_AT, {
    fetchPage: swim.fetchPage,
    pauseMs: 0,
  });
  assert.equal(result.items.length, 291);
});

test('event IDs come from the page URL, never the dates', async () => {
  const { eventListingId } = await import('../../lib/connectors.mjs');
  assert.equal(
    eventListingId('park', 'https://www.assiniboinepark.ca/events/boo-at-the-zoo/info'),
    'park-boo-at-the-zoo-info',
  );
  assert.equal(
    eventListingId('forks', 'https://www.theforks.com/events/calendar-of-events/event/1314'),
    'forks-event-1314',
  );
  assert.equal(
    eventListingId(
      'manitoba',
      'https://www.travelmanitoba.com/events/couples-clownselling-winnipeg/',
    ),
    'manitoba-couples-clownselling-winnipeg',
  );
  // Pages ending in the same segment no longer collide.
  assert.notEqual(
    eventListingId('park', 'https://www.assiniboinepark.ca/events/a/info'),
    eventListingId('park', 'https://www.assiniboinepark.ca/events/b/info'),
  );
  const long = 'https://example.test/events/' + 'very-long-name-'.repeat(10);
  assert.ok(eventListingId('park', long).length <= 'park-'.length + 80);
  assert.notEqual(
    eventListingId('park', 'https://example.test/e?occurrence=1'),
    eventListingId('park', 'https://example.test/e?occurrence=2'),
  );
  // The same event parsed on two different days keeps its ID.
  const today = parseSource('park', page('park-page-1'), '2026-10-08T12:00:00Z');
  const later = parseSource('park', page('park-page-1'), '2026-10-20T12:00:00Z');
  assert.deepEqual(
    today.map((item) => item.id),
    later.map((item) => item.id),
  );
});
