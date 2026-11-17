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
  assert.deepEqual(annualDates('The parade returns November 14, 2026.'), {
    start: '2026-11-14',
    end: '2026-11-14',
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

test('Tourism detects exhibitions in full bilingual descriptions and ignores venue names', () => {
  const page = detail(
    false,
    'October 27, 2026 to November 20, 2026',
    'Texte français. '.repeat(150) + ' This exhibition runs from August 27 to November 20.',
  );
  const parsed = parseTourismDetail(page, event);
  assert.equal(parsed.isExhibition, true);
  assert.ok(!parsed.description.includes('This exhibition'));
  assert.equal(parsed.runDates, null); // A published structured end date is required as year evidence.
  assert.equal(
    parseTourismDetail(
      detail(false, 'October 31, 2026', 'Racing at Exhibition Park.').replace(
        'Test exhibition',
        'Racing',
      ),
      event,
    ).isExhibition,
    false,
  );
});

test('Tourism preserves organizer run dates and date-only daily cards for continuous all-day exhibitions', async () => {
  const organizer = 'https://ccfm.mb.ca/en/events/test-portraits/';
  const { readFile } = await import('node:fs/promises');
  const official = await readFile('scripts/fixtures/tourism/organizer.html', 'utf8');
  const title = 'Exposition Test Portraits',
    listing = entry('2026-10-01', '2026-11-20', { name: title });
  const page = detail(
    false,
    'October 27, 2026 to November 20, 2026',
    'Texte. '.repeat(200) + ' A photography exhibition.',
  )
    .replace('Test exhibition', title)
    .replace(
      '<div class="body">',
      '<div class="contact-details">Venue: Test Art Gallery<br>URL: <a href="' +
        organizer +
        '">Visit Website</a></div><div class="body">',
    );
  const captured = [];
  const r = await collect([listing], {
    onEventPage: (page) => captured.push(page),
    fetchImpl: async (u) =>
      new Response(
        u === C
          ? calendar([listing])
          : u === A
            ? directory
            : u === festival
              ? detail(true, 'TBD')
              : u === organizer
                ? official
                : page,
      ),
  });
  assert.equal(r.failedPages.length, 0);
  const item = r.items.find((e) => e.sourceIdentity === 'tourism:event:100');
  assert.equal(item.start, '2026-08-27');
  assert.equal(item.end, '2026-11-20');
  assert.equal(item.runDates.sourceUrl, organizer);
  const capturedMain = captured.find((page) => page.id === item.id);
  assert.equal(capturedMain.supportingPages.find((page) => page.url === organizer).html, official);
  assert.equal(item.occurrences.length, 51);
  assert.equal(item.occurrences[0].start, '2026-10-01');
  assert.equal(item.occurrences.at(-1).start, '2026-11-20');
  assert.ok(item.occurrences.every((o) => o.start === o.end && !o.startAt && !o.endAt && !o.time));
  const failed = await collect([listing], {
    knownListings: new Map([[item.id, item]]),
    fetchImpl: async (u) =>
      u === organizer
        ? new Response('Unavailable', { status: 503 })
        : new Response(
            u === C
              ? calendar([listing])
              : u === A
                ? directory
                : u === festival
                  ? detail(true, 'TBD')
                  : page,
          ),
  });
  assert.ok(failed.failedPages.length);
  assert.equal(failed.completeSchedules, false);
  assert.equal(failed.items[0].runDates.start, '2026-08-27');
  assert.equal(failed.items[0].occurrences.length, 51);
});

test('Tourism rejects mismatched or unsafe organizer pages and recovers only consistent narrative bounds', async () => {
  const { tourismRunDates, parseTourismOrganizer } =
    await import('../../lib/server/tourism-winnipeg.mjs');
  assert.deepEqual(
    tourismRunDates(
      'New exhibition from August 27 to November 20. Opening August 27.',
      '2026-11-20',
    ),
    { start: '2026-08-27', end: '2026-11-20' },
  );
  assert.equal(tourismRunDates('From August 27 to November 19.', '2026-11-20'), null);
  assert.equal(tourismRunDates('From August 27, 2025 to November 20.', '2026-11-20'), null);
  assert.equal(
    tourismRunDates('From August 27 to November 20. From August 28 to November 20.', '2026-11-20'),
    null,
  );
  assert.throws(
    () => tourismUrl('https://evil.test/en/events/test-portraits/', 'organizer'),
    /Refused/,
  );
  assert.throws(
    () =>
      parseTourismOrganizer(
        '<h1>Different event</h1>',
        'https://ccfm.mb.ca/en/events/test-portraits/',
        'Test Portraits',
      ),
    /title does not match/,
  );
});

test('Tourism combines a verified organizer exhibition with its homepage alias without duplicate days', async () => {
  const { readFile } = await import('node:fs/promises'),
    official = await readFile('scripts/fixtures/tourism/organizer.html', 'utf8');
  const organizer = 'https://ccfm.mb.ca/en/events/test-portraits/',
    title = 'Exposition Test Portraits',
    aliasUrl = event.replace('/100/', '/101/');
  const primary = entry('2026-10-01', '2026-11-20', { name: title }),
    alias = entry('2026-10-01', '2026-11-20', {
      name: 'Exhibition Test Portraits - Artist',
      url: aliasUrl,
    });
  const contact = (href) =>
    '<div class="contact-details">Venue: Test Art Gallery<br>Address: Test street<br>URL: <a href="' +
    href +
    '">Visit Website</a></div><div class="body">';
  const primaryPage = detail(false, 'October 27, 2026 to November 20, 2026', 'An exhibition.')
    .replace('Test exhibition', title)
    .replace('<div class="body">', contact(organizer));
  const aliasPage = detail(
    false,
    'October 27, 2026 to November 20, 2026 All day',
    'A new exhibition from August 27 to November 20.',
  )
    .replace('Test exhibition', alias.name)
    .replace('<div class="body">', contact('https://ccfm.mb.ca/'))
    .replace(
      '</div></div></div>',
      '</div></div>' +
        '<script type="application/ld+json">' +
        JSON.stringify(alias) +
        '</script></div>',
    );
  const captured = [];
  const r = await collect([primary, alias], {
    onEventPage: (page) => captured.push(page),
    fetchImpl: async (u) =>
      new Response(
        u === C
          ? calendar([primary, alias])
          : u === A
            ? directory
            : u === festival
              ? detail(true, 'TBD')
              : u === organizer
                ? official
                : u === aliasUrl
                  ? aliasPage
                  : primaryPage,
      ),
  });
  assert.equal(r.organizerAliases, 1);
  assert.ok(!captured.some((page) => page.url === aliasUrl));
  const shows = r.items.filter((e) => e.type === 'Event');
  assert.equal(shows.length, 1);
  assert.equal(shows[0].occurrences.length, 51);
  assert.deepEqual(shows[0].sourceLinks, [aliasUrl]);
  assert.ok(r.supersededIds.some((id) => id.endsWith('101')));
  assert.equal(shows[0].venue, 'Test Art Gallery');
});

test('Tourism recognizes gallery collections without an English exhibition keyword', () => {
  const page = detail(false, 'October 28, 2026', 'A collection of works by an artist.')
    .replace('Test exhibition', 'Carvings')
    .replace(
      '<div class="body">',
      '<div class="contact-details">Venue: Art Gallery<br>URL: example</div><div class="body">',
    );
  assert.equal(parseTourismDetail(page, event).isExhibition, true);
});

test('Tourism captures each retained detail page once without fetching during extraction', async () => {
  const pages = [];
  const unrelated = event.replace('/100/', '/101/');
  const result = await collect(
    [entry('2026-10-28'), entry('2026-10-29', '2026-10-29', { url: unrelated })],
    { onEventPage: (page) => pages.push(page) },
  );
  assert.equal(pages.length, result.items.length);
  const main = pages.find((page) => page.url === event);
  assert.equal(main.id, result.items[0].id);
  assert.deepEqual(main.itemIds, [result.items[0].id]);
  assert.equal(main.html, detail());
  assert.equal(main.supportingPages.length, 1);
  assert.equal(main.supportingPages[0].url, C);
  assert.match(main.supportingPages[0].html, /2026-10-28/);
  assert.ok(!main.supportingPages[0].html.includes(unrelated));
  assert.ok(!main.supportingPages[0].html.includes('2026-10-29'));
  assert.match(main.selector, /event-description-block/);
  const { sources } = await import('../../lib/connectors.mjs');
  assert.equal(sources.find((s) => s.id === 'tourism-winnipeg').defaultVenue, undefined);
});

test('bounded Tourism samples report incomplete coverage and do not fetch remaining details', async () => {
  const pages = [];
  const result = await collect([entry('2026-10-28')], {
    maxEvents: 1,
    onEventPage: (page) => pages.push(page),
  });
  assert.equal(result.eventPagesRead, 1);
  assert.equal(pages.length, 1);
  assert.ok(result.failedPages.some((page) => /detail limit reached/.test(page.error)));
  assert.equal(result.completeSchedules, false);
});

test('Tourism parser fallback retains known clock times and IDs without filling calendar gaps', async () => {
  const rows = [entry('2026-10-28'), entry('2026-11-04')];
  const baseline = await collect(rows);
  const item = baseline.items[0];
  Object.assign(item.occurrences[0], {
    startAt: '2026-10-28T18:00:00.000Z',
    endAt: '2026-10-28T22:00:00.000Z',
    time: '12–4 PM',
    endTimeKnown: true,
    timeZone: 'America/Winnipeg',
  });
  const repeat = await collect(rows, { knownListings: new Map([[item.id, item]]) });
  assert.deepEqual(repeat.items[0].occurrences, item.occurrences);
});
