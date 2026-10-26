import test from 'node:test';
import assert from 'node:assert/strict';
import {
  annualDates,
  collectTourism,
  parseTourismDetail,
  parseTourismCalendar,
  tourismUrl,
  TOURISM_CALENDAR as C,
  TOURISM_ANNUAL as A,
} from '../../lib/server/tourism-winnipeg.mjs';
import { entry, calendar, directory, detail, event, festival } from '../fixtures/tourism/pages.mjs';
const stored = '/api/photos/' + 'd'.repeat(64),
  png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const collect = (entries, options = {}) =>
  collectTourism({}, '2026-10-26T12:00:00Z', {
    pauseMs: 0,
    fetchImpl: async (u) =>
      new Response(
        u === C
          ? calendar(entries)
          : u === A
            ? directory
            : u === festival
              ? detail(true, 'Dates TBD')
              : u.includes('/uploads/')
                ? png
                : detail(),
      ),
    ...options,
  });
test('Tourism visits explicit exhibition days while respecting gaps and retaining shared details', async () => {
  const r = await collect([entry('2026-10-28', '2026-10-30'), entry('2026-11-04', '2026-11-05')]);
  assert.equal(r.failedPages.length, 0);
  assert.equal(r.items[0].occurrences.length, 5);
  assert.ok(!r.items[0].occurrences.some((e) => e.start === '2026-11-02'));
  assert.equal(r.items[0].price, null);
  assert.equal(r.items[1].status, 'hidden');
  assert.equal(r.items[1].start, undefined);
});
test('Tourism never expands broad unverified exhibition runs or invents annual dates', async () => {
  const r = await collect([entry('2026-10-01', '2026-11-30')]);
  assert.equal(r.items[0].status, 'hidden');
  assert.equal(r.reviewRequired, 2);
  assert.equal(parseTourismDetail(detail(true, 'October 2026'), festival).exactDates, null);
  assert.equal(
    parseTourismDetail(detail(true, 'October 30–31, 2026'), festival).exactDates.end,
    '2026-10-31',
  );
});
test('Tourism annual overlap requires explicit calendar links, never title-only matches', async () => {
  const r = await collect([entry('2026-10-31')], {
    fetchImpl: async (u) =>
      new Response(
        u === C
          ? calendar([entry('2026-10-31')])
          : u === A
            ? directory
            : u === festival
              ? detail(true, 'TBD', '<a href="' + event + '">Current edition</a>')
              : detail(),
      ),
  });
  assert.equal(r.annualMatched, 1);
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.items[0].sourceLinks, [festival]);
});
test('Tourism pagination/filter and changed markup failures preserve partial reads', async () => {
  const link = '<a href="' + C + '/filter:test/page:2">Next</a>';
  const r = await collect([entry('2026-10-31')], {
    fetchImpl: async (u) =>
      u.includes('/page:2')
        ? new Response('Down', { status: 503 })
        : new Response(
            u === C
              ? calendar([entry('2026-10-31')], link)
              : u === A
                ? directory
                : detail(u === festival),
          ),
  });
  assert.ok(r.failedPages.length);
  assert.equal(r.items[0].occurrencesComplete, false);
  assert.throws(
    () => parseTourismCalendar('challenge', { from: '2026-10-01', to: '2026-11-30' }),
    /filter/,
  );
  assert.throws(() => tourismUrl('https://evil.test/a'), /Refused/);
});
test('Tourism private photos are cached across entries and retained when enrichment fails', async () => {
  let count = 0;
  const r = await collect([entry('2026-10-31')], {
    storePhoto: async () => {
      count++;
      return stored;
    },
  });
  assert.equal(count, 1);
  const knownListings = new Map(r.items.map((e) => [e.id, e]));
  const again = await collect([entry('2026-10-31')], {
    knownListings,
    storePhoto: () => {
      throw Error('Must reuse');
    },
  });
  assert.equal(again.failedPages.length, 0);
  assert.equal(again.items[0].image, stored);
  for (const e of knownListings.values()) e.sourceImages = [];
  const fail = await collect([entry('2026-10-31')], {
    knownListings,
    storePhoto: () => {
      throw Error('Down');
    },
  });
  assert.ok(fail.failedPages.length);
  assert.equal(fail.items[0].image, stored);
});

test('Tourism confirms edition ranges without default years or impossible dates', () => {
  assert.deepEqual(annualDates('Join us from October 30 to November 1, 2026, in Winnipeg.'), {
    start: '2026-10-30',
    end: '2026-11-01',
  });
  assert.deepEqual(annualDates('November 28, 2025 – January 3, 2026'), {
    start: '2025-11-28',
    end: '2026-01-03',
  });
  assert.equal(annualDates('February 30–31, 2026'), null);
  assert.equal(annualDates('October 30–31'), null);
  assert.equal(annualDates('September 2026'), null);
});
test('Tourism merges only an unambiguous matching annual edition and keeps unknown times unknown', async () => {
  const e = entry('2026-10-30', '2026-10-31', {
    name: 'Annual Festival',
    description: 'A festival.',
  });
  const r = await collect([e], {
    fetchImpl: async (u) =>
      new Response(
        u === C
          ? calendar([e])
          : u === A
            ? directory
            : detail(u === festival, 'October 30–31, 2026', 'Festival details.').replace(
                'Test exhibition',
                'Annual Festival',
              ),
      ),
  });
  assert.equal(r.annualMatched, 1);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].occurrences.length, 1);
  assert.equal(r.items[0].occurrences[0].time, '');
});
