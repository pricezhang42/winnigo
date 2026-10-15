import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  collectMuseum,
  museumTimestamp,
  parseMuseumMonth,
  parseMuseumDetail,
  parseMuseumRun,
  museumUrl,
  MUSEUM_CALENDAR,
} from '../../lib/server/museum.mjs';
import { listingDedupeKey } from '../../lib/connectors.mjs';
import { invalidReason } from '../../lib/server/collection.mjs';
const fixture = (n) =>
  readFileSync(new URL('../fixtures/museum/' + n + '.html', import.meta.url), 'utf8');
const exhibition = fixture('exhibition'),
  detail = fixture('event');
const source = { id: 'manitoba-museum', name: 'Manitoba Museum', url: MUSEUM_CALENDAR };
const now = '2026-10-14T12:00:00Z';
const event = (slug, date, time = '10:00:00', extra = {}) => ({
  '@type': 'Event',
  name: 'Paper exhibition',
  url: `https://manitobamuseum.ca/event/${slug}/`,
  startDate: `${date}T${time}${date < '2026-11-01' ? '-05:00' : '-06:00'}`,
  endDate: `${date}T16:00:00${date < '2026-11-01' ? '-05:00' : '-06:00'}`,
  ...extra,
});
const month = (events) =>
  '<div data-view="month">' +
  (events.length ? '' : 'No events scheduled') +
  '</div><script type="application/ld+json">' +
  JSON.stringify(events) +
  '</script>';
const a = event('paper/2026-10-14', '2026-10-14'),
  b = event('paper/2026-11-01', '2026-11-01');
const transport =
  (oct = [a], nov = [b], pages = {}) =>
  async (url) =>
    new Response(
      url.includes('/month/2026-10/')
        ? month(oct)
        : url.includes('/month/2026-11/')
          ? month(nov)
          : pages[url] || exhibition,
    );

test('Museum run dates preserve closing-month precision and validate overall dates', () => {
  assert.deepEqual(
    parseMuseumRun('The exhibition opened May 1, 2026 and is on display until April 2027.'),
    { start: '2026-05-01', endMonth: '2027-04' },
  );
  assert.deepEqual(
    parseMuseumRun('Opening on May 1, 2026. The exhibition closes on April 15, 2027.'),
    { start: '2026-05-01', end: '2027-04-15' },
  );
  assert.deepEqual(
    parseMuseumRun('October 15 @ 10 am–4 pm. First shown in Vancouver July 1, 2023.'),
    {},
  );
  assert.throws(() => parseMuseumRun('The exhibition opened February 30, 2026.'), /invalid/);
  assert.throws(
    () => parseMuseumRun('The exhibition opened May 1, 2026 and is on display until April 2025.'),
    /disagree/,
  );
  assert.throws(() => parseMuseumRun('The exhibition closes April 31, 2027.'), /invalid/);
});

test('month parsing accepts graph data and explicit empty calendars, rejects changed/unsafe data', () => {
  const e = parseMuseumMonth(month([a]));
  assert.equal(e.events[0].startDay, '2026-10-14');
  assert.equal(parseMuseumMonth(month([])).empty, true);
  assert.equal(parseMuseumMonth(month({ '@graph': [a] })).events.length, 1);
  assert.throws(() => parseMuseumMonth('Blocked'), /layout/);
  assert.throws(
    () => parseMuseumMonth(month([{ ...a, startDate: '2026-02-30T10:00:00-06:00' }])),
    /invalid/,
  );
  assert.throws(
    () => parseMuseumMonth(month([{ ...a, url: 'https://other.test/event/a/' }])),
    /Refused/,
  );
  assert.throws(() => museumUrl('https://manitobamuseum.ca/wp-admin/'), /Refused/);
  assert.throws(
    () => parseMuseumMonth('<script type="application/ld+json">{broken</script>'),
    /malformed/,
  );
});

test('one source series spans months, deduplicates overlapping calendars, and keeps DST offsets', async () => {
  const result = await collectMuseum(source, now, {
    pauseMs: 0,
    fetchImpl: transport([a, b], [b]),
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.occurrencesFound, 2);
  const item = result.items[0];
  assert.equal(item.start, '2026-05-01');
  assert.equal(item.endMonth, '2027-04');
  assert.equal(item.end, undefined);
  assert.equal(item.schedule, 'series');
  assert.equal(item.price, null);
  assert.equal(invalidReason(item), null);
  assert.equal(item.observedThrough, '2026-11-01');
  assert.match(item.occurrenceSamples[0].start, /-05:00$/);
  assert.match(item.occurrenceSamples[1].start, /-06:00$/);
  const repeat = await collectMuseum(source, '2026-11-01T12:00:00Z', {
    pauseMs: 0,
    fetchImpl: async (url) => new Response(url.includes('/month/') ? month([b]) : exhibition),
  });
  assert.equal(repeat.items[0].id, item.id);
});

test('same names on different source series stay separate; once-only events retain dates/time', async () => {
  const once = event('evening-2026', '2026-10-18', '10:00:00', { name: 'Evening program' });
  const other = event('different-paper/2026-10-20', '2026-10-20');
  const result = await collectMuseum(source, now, {
    pauseMs: 0,
    fetchImpl: transport([a, once, other], [], { [once.url]: detail }),
  });
  assert.equal(result.items.length, 3);
  assert.equal(new Set(result.items.map(listingDedupeKey)).size, 3);
  const item = result.items.find((e) => e.title === 'Evening program');
  assert.equal(item.start, '2026-10-18');
  assert.equal(item.end, '2026-10-18');
  assert.equal(item.schedule, 'event');
  assert.match(item.time, /10/);
});

test('unknown series bounds remain unknown; prior verified run survives narrower or stripped reads', async () => {
  const first = await collectMuseum(source, now, { pauseMs: 0, fetchImpl: transport() });
  const previous = first.items[0];
  const result = await collectMuseum(source, now, {
    pauseMs: 0,
    knownListings: new Map([[previous.id, previous]]),
    fetchImpl: transport([a], [], { [a.url]: detail }),
  });
  assert.equal(result.items[0].start, '2026-05-01');
  assert.equal(result.items[0].endMonth, '2027-04');
  const unknown = await collectMuseum(source, now, {
    pauseMs: 0,
    fetchImpl: transport([a], [], { [a.url]: detail }),
  });
  assert.equal(unknown.items[0].start, '2026-10-14');
  assert.equal(unknown.items[0].end, '2026-10-14');
  assert.equal(unknown.items[0].recurring, true);
  assert.equal(unknown.items[0].runDates, undefined);
  const exact = exhibition.replace('until April 2027', 'until April 15, 2027');
  const updated = await collectMuseum(source, now, {
    pauseMs: 0,
    knownListings: new Map([[previous.id, previous]]),
    fetchImpl: transport([a], [], { [a.url]: exact }),
  });
  assert.equal(updated.items[0].end, '2027-04-15');
  assert.equal(updated.items[0].endMonth, undefined);
});

test('partial month/detail reads preserve successes; repeated failures cannot bypass the page bound', async () => {
  const fetchImpl = async (url) =>
    url.includes('/month/2026-11/') ? new Response('Bad page') : transport([a])(url);
  const result = await collectMuseum(source, now, { pauseMs: 0, fetchImpl });
  assert.equal(result.items.length, 1);
  assert.equal(result.failedPages.length, 1);
  assert.equal(result.allowEmpty, false);
  let details = 0;
  const limited = await collectMuseum(source, now, {
    pauseMs: 0,
    maxGroups: 1,
    fetchImpl: async (url) => {
      if (url.includes('/month/'))
        return new Response(month([a, event('other/2026-10-16', '2026-10-16')]));
      details++;
      return new Response('changed');
    },
  });
  assert.equal(details, 1);
  assert.equal(limited.items.length, 0);
  assert.equal(limited.failedPages.length, 2);
  await assert.rejects(
    collectMuseum(source, now, { pauseMs: 0, fetchImpl: async () => new Response('Bad') }),
    /layout/,
  );
  const empty = await collectMuseum(source, now, {
    pauseMs: 0,
    fetchImpl: async () => new Response(month([])),
  });
  assert.equal(empty.allowEmpty, true);
});

test('source photos are limited and private storage failures withhold the group; saved photos are reused', async () => {
  const image = 'https://manitobamuseum.ca/wp-content/uploads/2026/10/art.jpg';
  const e = { ...a, image };
  const saved = '/api/photos/' + 'a'.repeat(64);
  let downloads = 0;
  const fetchImpl = async (url) => {
    if (url === image) {
      downloads++;
      return new Response(new Uint8Array([255, 216, 255, 0]));
    }
    return transport([e], [])(url);
  };
  const good = await collectMuseum(source, now, {
    pauseMs: 0,
    fetchImpl,
    storePhoto: async () => saved,
  });
  assert.deepEqual(good.items[0].images, [saved]);
  const repeat = await collectMuseum(source, now, {
    pauseMs: 0,
    fetchImpl,
    knownListings: new Map([[good.items[0].id, good.items[0]]]),
    storePhoto: async () => {
      throw Error('should not store');
    },
  });
  assert.equal(repeat.items.length, 1);
  assert.equal(downloads, 1);
  const failed = await collectMuseum(source, now, {
    pauseMs: 0,
    fetchImpl,
    storePhoto: async () => {
      throw Error('Private storage message');
    },
  });
  assert.equal(failed.items.length, 0);
  assert.doesNotMatch(JSON.stringify(failed), /Private storage/);
  const images = parseMuseumDetail(
    exhibition.replace(
      '</p>',
      '</p><img src="' +
        image +
        '"><img src="https://other.test/a.jpg"><img src="https://manitobamuseum.ca/wp-content/uploads/logo.jpg">',
    ),
    e,
  ).images;
  assert.deepEqual(images, [image]);
});

test('end month validation rejects invented/impossible mixed precision', () => {
  const base = { title: 'test', url: a.url };
  assert.equal(invalidReason({ ...base, start: '2026-05-01', endMonth: '2027-04' }), null);
  assert.equal(invalidReason({ ...base, endMonth: '2027-13' }), 'end month');
  assert.equal(invalidReason({ ...base, end: '2027-04-30', endMonth: '2027-04' }), 'end month');
});

test('printed overall ranges and matching EventSeries dates can establish precise run bounds', () => {
  assert.deepEqual(parseMuseumRun('The exhibition runs November 1–November 30, 2026.'), {
    start: '2026-11-01',
    end: '2026-11-30',
  });
  const series = {
    '@type': 'EventSeries',
    url: 'https://manitobamuseum.ca/event/paper/',
    startDate: '2026-05-01',
    endDate: '2027-04-15',
  };
  const page =
    exhibition + '<script type="application/ld+json">' + JSON.stringify(series) + '</script>';
  assert.deepEqual(parseMuseumDetail(page, a).run, { start: '2026-05-01', end: '2027-04-15' });
  assert.throws(() => parseMuseumDetail(page.replace('2027-04-15', '2027-03-15'), a), /disagree/);
  assert.deepEqual(parseMuseumDetail(page.replace('/event/paper/', '/event/unrelated/'), a).run, {
    start: '2026-05-01',
    endMonth: '2027-04',
  });
  const wrong =
    month([a]) +
    '<script data-js="tribe-events-view-data">{"url_event_date":"2026-10-01"}</script>';
  assert.throws(() => parseMuseumMonth(wrong, '2026-11'), /different calendar month/);
});

test('Museum event photos support schema arrays and count WordPress sizes as one image', () => {
  const base = 'https://manitobamuseum.ca/wp-content/uploads/2026/10/';
  const parsed = parseMuseumDetail(exhibition, {
    ...a,
    image: [
      base + 'cover-300x200.jpg',
      { url: base + 'cover-scaled.jpg' },
      { contentUrl: base + 'second.png' },
      base + 'third.webp',
      base + 'fourth.jpg',
    ],
  });
  assert.deepEqual(parsed.images, [
    base + 'cover-300x200.jpg',
    base + 'second.png',
    base + 'third.webp',
  ]);
});

test('canonical event redirects stay within the Museum series; external and other-series redirects fail', async () => {
  const once = event('once', '2026-10-18');
  const run = (location) =>
    collectMuseum(source, now, {
      pauseMs: 0,
      fetchImpl: async (url) =>
        url.includes('/month/')
          ? new Response(month([once]))
          : url === once.url
            ? Response.redirect(location, 302)
            : new Response(detail),
    });
  assert.equal((await run('https://manitobamuseum.ca/event/once/2026-10-18/')).items.length, 1);
  const other = await run('https://manitobamuseum.ca/event/other/');
  assert.equal(other.items.length, 0);
  assert.match(other.failedPages[0].error, /different series/);
  const external = await run('https://other.test/event/once/');
  assert.equal(external.items.length, 0);
  assert.match(external.failedPages[0].error, /Refused/);
});

test('explicit one-night events use calendar dates without crawling a booking redirect', async () => {
  const once = event('night-only', '2026-11-21', '10:00:00', {
    name: 'Night program',
    description: 'For one night only, explore the galleries.',
  });
  const result = await collectMuseum(source, now, {
    pauseMs: 0,
    fetchImpl: async (url) => {
      assert.match(url, /\/month\//);
      return new Response(month([once]));
    },
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].start, '2026-11-21');
  assert.equal(result.items[0].end, '2026-11-21');
  assert.equal(result.items[0].schedule, 'event');
  assert.equal(result.eventPagesRead, 0);
});

test('recurring programs become distinct sessions for both full months, with DST and cancellations', async () => {
  const early = event('program/2026-10-02', '2026-10-02');
  const first = event('program/2026-10-15', '2026-10-15');
  const second = event('program/2026-11-06', '2026-11-06', '10:00:00', {
    eventStatus: 'https://schema.org/EventCancelled',
  });
  const after = event('program/2026-12-01', '2026-12-01');
  const before = event('program/2026-09-30', '2026-09-30');
  let requests = 0;
  const fetchImpl = async (url) => {
    requests++;
    return new Response(
      url.includes('/month/2026-10/')
        ? month([before, early, first, second])
        : url.includes('/month/2026-11/')
          ? month([second, after])
          : detail,
    );
  };
  const result = await collectMuseum(source, now, { pauseMs: 0, fetchImpl });
  assert.equal(result.items.length, 3);
  assert.equal(requests, 3); // one detail request for the source program
  assert.equal(result.occurrencesFound, 3);
  assert.equal(result.observedFrom, '2026-10-01');
  assert.equal(result.observedThrough, '2026-11-30');
  assert.equal(new Set(result.items.map((e) => e.id)).size, 3);
  assert.equal(new Set(result.items.map(listingDedupeKey)).size, 3);
  assert.equal(new Set(result.items.map((e) => e.seriesId)).size, 1);
  assert.deepEqual(
    result.items.map((e) => e.start),
    ['2026-10-02', '2026-10-15', '2026-11-06'],
  );
  for (const item of result.items) {
    assert.equal(item.type, 'Event');
    assert.equal(item.schedule, 'event');
    assert.equal(item.recurring, true);
    assert.equal(invalidReason(item), null);
    assert.equal(item.end, item.start);
    assert.match(item.time, /10:00/);
    assert.equal(item.occurrenceSamples.length, 1);
  }
  assert.match(result.items[1].startAt, /-05:00$/);
  assert.match(result.items[2].startAt, /-06:00$/);
  assert.equal(result.items[2].status, 'cancelled');
  const repeat = await collectMuseum(source, '2026-11-15T12:00:00Z', { pauseMs: 0, fetchImpl });
  assert.equal(repeat.items.find((e) => e.start === '2026-11-06').id, result.items[2].id);
});

test('shared source URL supports multiple same-day sessions and equivalent timestamp deduplication', async () => {
  const morning = event('program', '2026-10-15');
  const equivalent = { ...morning, startDate: '2026-10-15T15:00:00Z' };
  const afternoon = event('program', '2026-10-15', '13:00:00');
  const result = await collectMuseum(source, now, {
    pauseMs: 0,
    fetchImpl: transport([morning, equivalent, afternoon], [], { [morning.url]: detail }),
  });
  assert.equal(result.items.length, 2);
  assert.notEqual(result.items[0].id, result.items[1].id);
  assert.equal(result.items[0].url, result.items[1].url);
});

test('program summary retires only after its replacement sessions and photos succeed', async () => {
  const e = { ...a, image: 'https://manitobamuseum.ca/wp-content/uploads/art.jpg' };
  const previous = {
    id: 'manitoba-museum-event-paper',
    title: a.name,
    url: a.url,
    schedule: 'series',
  };
  const knownListings = new Map([[previous.id, previous]]);
  const success = await collectMuseum(source, now, {
    pauseMs: 0,
    knownListings,
    fetchImpl: transport([a], [], { [a.url]: detail }),
  });
  assert.deepEqual(success.supersededIds, [previous.id]);
  const failure = await collectMuseum(source, now, {
    pauseMs: 0,
    knownListings,
    storePhoto: async () => {
      throw Error('broken');
    },
    fetchImpl: async (url) =>
      url.includes('/uploads/')
        ? new Response(new Uint8Array([255, 216, 255, 0]))
        : transport([e], [], { [e.url]: detail })(url),
  });
  assert.equal(failure.items.length, 0);
  assert.deepEqual(failure.supersededIds, []);
  assert.equal(failure.failedPages.length, 1);
});

test('full-month window crosses December into January without including adjacent-grid dates', async () => {
  const entries = ['2026-11-30', '2026-12-01', '2027-01-31', '2027-02-01'].map((day) =>
    event('program/' + day, day),
  );
  const result = await collectMuseum(source, '2026-12-31T15:00:00Z', {
    pauseMs: 0,
    fetchImpl: async (url) => new Response(url.includes('/month/') ? month(entries) : detail),
  });
  assert.equal(result.observedFrom, '2026-12-01');
  assert.equal(result.observedThrough, '2027-01-31');
  assert.deepEqual(
    result.items.map((e) => e.start),
    ['2026-12-01', '2027-01-31'],
  );
  assert.equal(invalidReason({ ...result.items[0], startAt: 'bad' }), 'occurrence timestamps');
  assert.equal(invalidReason({ ...result.items[0], seriesId: '' }), 'recurring identity');
});

test('detail cancellation applies to one session unless the whole program is explicitly cancelled', async () => {
  const second = event('paper/2026-10-22', '2026-10-22');
  for (const [message, expected] of [
    ['This event has been cancelled.', ['cancelled', 'active']],
    ['All sessions have been cancelled.', ['cancelled', 'cancelled']],
  ]) {
    const body = detail.replace('Join a synthetic evening program for families.', message);
    const result = await collectMuseum(source, now, {
      pauseMs: 0,
      fetchImpl: transport([a, second], [], { [a.url]: body }),
    });
    assert.deepEqual(
      result.items.map((e) => e.status),
      expected,
    );
  }
});

test('cached calendar offsets use the occurrence date DST and preserve published values', async () => {
  assert.equal(museumTimestamp('2026-11-26T19:00:00-05:00'), '2026-11-26T19:00:00-06:00');
  assert.equal(museumTimestamp('2026-10-29T19:00:00-06:00'), '2026-10-29T19:00:00-05:00');
  assert.equal(museumTimestamp('2026-11-26T01:00:00Z'), '2026-11-26T01:00:00Z');
  assert.equal(museumTimestamp('2026-11-01T01:30:00-05:00'), '2026-11-01T01:30:00-05:00');
  assert.equal(museumTimestamp('2026-11-01T01:30:00-06:00'), '2026-11-01T01:30:00-06:00');
  assert.throws(() => museumTimestamp('2026-03-08T02:30:00-06:00'), /local time/);
  const e = event('program/2026-11-26', '2026-11-26', '19:00:00', {
    startDate: '2026-11-26T19:00:00-05:00',
    endDate: '2026-11-26T20:00:00-05:00',
  });
  const result = await collectMuseum(source, now, {
    pauseMs: 0,
    fetchImpl: transport([], [e], { [e.url]: detail }),
  });
  const item = result.items[0];
  assert.equal(item.startAt, '2026-11-26T19:00:00-06:00');
  assert.match(item.time, /7:00/);
  assert.equal(item.occurrenceSamples[0].publishedStart, e.startDate);
  const old = { ...item, id: 'old-bad-offset', startAt: e.startDate, endAt: e.endDate };
  const repeat = await collectMuseum(source, now, {
    pauseMs: 0,
    knownListings: new Map([[old.id, old]]),
    fetchImpl: transport([], [e], { [e.url]: detail }),
  });
  assert.deepEqual(repeat.supersededIds, [old.id]);
  assert.equal(repeat.items[0].id, item.id);
});
