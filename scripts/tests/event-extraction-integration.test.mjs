import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareExtractedCollection } from '../../lib/server/event-extraction-integration.mjs';
import { context, date, examples, single } from '../fixtures/event-extraction.mjs';

const source = { id: context.source, name: 'Synthetic public events' };
const options = {
  source,
  identifyEvent: (url) => {
    if (new URL(url).origin !== 'https://events.example.test') throw Error('Outside source');
    return { eventUrl: url, sourceIdentity: 'verified:concert' };
  },
};
const preview = (value = single, input = context, extra = {}) =>
  prepareExtractedCollection(value, input, { ...options, ...extra });
const example = (prefix) => structuredClone(examples.find((e) => e.name.startsWith(prefix)));
const changed = (change) => {
  const value = structuredClone(single);
  change(value.event, value);
  return value;
};
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const photo = '/api/photos/' + 'c'.repeat(64);
const photoPolicy = (extra = {}) => ({
  validateUrl: (url) => {
    if (!url.startsWith('https://events.example.test/photos/')) throw Error('Outside photo scope');
    return url;
  },
  read: async () => png,
  storePhoto: async ({ contentType }) => {
    assert.equal(contentType, 'image/png');
    return photo;
  },
  ...extra,
});

test('maps one event using source identity, provenance and an unknown end time, without writing', async () => {
  const result = await preview();
  assert.equal(result.status, 'ok');
  assert.equal(result.completeSchedules, false);
  const [item] = result.items;
  assert.equal(item.source, source.id);
  assert.equal(item.url, context.pageUrl);
  assert.equal(item.sourceIdentity, 'verified:concert');
  assert.equal(item.price, null);
  assert.deepEqual(item.scheduleCoverage, []);
  assert.equal(item.occurrencesComplete, false);
  assert.equal(item.occurrences[0].startAt, '2026-11-21T01:00:00.000Z');
  assert.equal(item.occurrences[0].endTimeKnown, false);
  assert.equal(item.extraction.schemaVersion, '3');
  assert.deepEqual(
    item.extraction.evidence.map((e) => e.quote),
    ['QA Concert', 'QA Hall', 'November 20, 2026 at 7 PM'],
  );
  assert.deepEqual((await preview()).items, result.items);
});

test('separates same-day showtimes, clips occurrences and records missing-year assumptions', async () => {
  const multiple = example('multiple');
  multiple.result.event.schedule.dates.push({
    ...multiple.result.event.schedule.dates[0],
    start: date(1, 1, 2027),
  });
  const [item] = (await preview(multiple.result, multiple.context)).items;
  assert.equal(item.recurring, true);
  assert.equal(item.occurrences.length, 3);
  assert.equal(new Set(item.occurrences.map((o) => o.id)).size, 3);
  assert.equal(item.occurrences.filter((o) => o.start === '2026-11-20').length, 2);
  const missing = example('missing year');
  const [dateOnly] = (await preview(missing.result, missing.context)).items;
  assert.equal(dateOnly.yearAssumed, true);
  assert.equal(dateOnly.occurrences[0].start, '2026-11-20');
  assert.equal(dateOnly.occurrences[0].startAt, undefined);
  assert.equal(dateOnly.extraction.schedule.dates[0].start.year, null);
});

test('expands weekly and first-Friday rules with Winnipeg DST and shared identities', async () => {
  const weekly = example('weekly');
  const [program] = (await preview(weekly.result, weekly.context)).items;
  assert.deepEqual(
    program.occurrences.map((o) => o.startAt),
    ['2026-10-26T00:00:00.000Z', '2026-11-02T01:00:00.000Z', '2026-11-09T01:00:00.000Z'],
  );
  const monthly = example('first Friday');
  const [fridays] = (await preview(monthly.result, monthly.context)).items;
  assert.deepEqual(
    fridays.occurrences.map((o) => o.start),
    ['2026-11-06', '2026-12-04'],
  );
  // Listed dates without times confirm the timed rule instead of adding date-only cards.
  const listed = example('first Friday');
  listed.context.documents[0].text += ' November 6, 2026. December 4, 2026. December 12, 2026.';
  listed.result.event.schedule.dates = ['November 6, 2026', 'December 4, 2026'].map((quote, i) => ({
    start: date(11 + i, i ? 4 : 6),
    end: null,
    startTime: null,
    endTime: null,
    cancelled: false,
    quote,
  }));
  const [confirmed] = (await preview(listed.result, listed.context)).items;
  assert.deepEqual(
    confirmed.occurrences.map((o) => o.startAt),
    ['2026-11-07T01:00:00.000Z', '2026-12-05T01:00:00.000Z'],
  );
  listed.result.event.schedule.dates.push({
    start: date(12, 12),
    end: null,
    startTime: null,
    endTime: null,
    cancelled: false,
    quote: 'December 12, 2026',
  });
  const [extra] = (await preview(listed.result, listed.context)).items;
  assert.deepEqual(
    extra.occurrences.map((o) => o.startAt ?? o.start),
    ['2026-11-07T01:00:00.000Z', '2026-12-05T01:00:00.000Z', '2026-12-12'],
  );
  monthly.result.event.schedule.recurrence[0].interval = 2;
  assert.equal(
    (await preview(monthly.result, monthly.context)).review[0].reason,
    'missing-recurrence-anchor',
  );
});

test('uses one exhibition card per visiting day and retains closing-month precision', async () => {
  const e = example('exhibition');
  const [item] = (await preview(e.result, e.context)).items;
  assert.deepEqual(item.runDates, { start: '2026-05-01', endMonth: '2027-04' });
  assert.equal(item.schedule, 'series');
  assert.ok(item.occurrences.some((o) => o.start === '2026-11-03'));
  assert.ok(!item.occurrences.some((o) => ['2026-11-02', '2026-12-25'].includes(o.start)));
  assert.equal(new Set(item.occurrences.map((o) => o.start)).size, item.occurrences.length);
  assert.deepEqual(item.scheduleCoverage, []);
  assert.equal(item.visitingSchedule, undefined);
  e.result.event.schedule.hours[0].weekly[0].endTime = null;
  assert.equal((await preview(e.result, e.context)).review[0].reason, 'unconfirmed-visiting-hours');
});

test('does not invent a timestamp for a repeated or missing DST wall time', async () => {
  for (const [checkedAt, month, day, time, from, to] of [
    ['2026-11-06T18:00:00Z', 11, 1, '01:30', '2026-11-01', '2026-12-31'],
    ['2026-03-06T18:00:00Z', 3, 8, '02:30', '2026-03-01', '2026-04-30'],
  ]) {
    const input = { ...context, checkedAt, window: { from, to } };
    const value = changed((e) =>
      Object.assign(e.schedule.dates[0], { start: date(month, day), startTime: time }),
    );
    const result = await preview(value, input);
    assert.deepEqual(result.items, []);
    assert.equal(result.review[0].reason, 'unresolved-schedule');
  }
});

test('preserves overnight times and uses no timed interval for an unknown multi-day boundary', async () => {
  const overnight = changed((e) =>
    Object.assign(e.schedule.dates[0], { startTime: '23:00', endTime: '01:00' }),
  );
  const [item] = (await preview(overnight)).items;
  assert.deepEqual([item.start, item.end], ['2026-11-20', '2026-11-21']);
  assert.equal(item.occurrences[0].endAt, '2026-11-21T07:00:00.000Z');
  const multiDay = changed((e) => {
    e.schedule.dates[0].end = date(11, 22);
  });
  const [openEnd] = (await preview(multiDay)).items;
  assert.equal(openEnd.end, '2026-11-22');
  assert.equal(openEnd.occurrences[0].endAt, undefined);
  assert.equal(openEnd.time, 'Starts 19:00');
});

test('ambiguous, invalid and unauthorized facts produce partial results with no candidates', async () => {
  const conflict = example('conflicting dates');
  for (const [result, reason] of [
    [await preview(conflict.result, conflict.context), 'source-facts-need-review'],
    [await preview(null), 'invalid-extraction'],
    [await preview({ event: null }), 'no-event-candidates'],
    [await preview(single, context, { identifyEvent: () => null }), 'unapproved-event-url'],
    [
      await preview(
        changed((e) => {
          e.schedule.dates[0].start = date(10, 20);
        }),
      ),
      'no-dates-in-collection-window',
    ],
    [
      await preview(
        changed((e) => {
          e.titleQuote = 'Invented title';
        }),
      ),
      'source-facts-need-review',
    ],
  ]) {
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.items, []);
    assert.equal(result.failedPages[0].error, reason);
  }
  await assert.rejects(
    preview(
      single,
      { ...context, source: 'facebook' },
      { source: { id: 'facebook', name: 'Facebook' } },
    ),
    /public event source/,
  );
});

test('withholds a context with more than one event before looking up its source identity', async () => {
  const multiple = changed((event, value) => {
    value.events = [event, structuredClone(event)];
  });
  const result = await preview(multiple, context, {
    identifyEvent: () => assert.fail('Only a single event can reach the source adapter'),
  });
  assert.deepEqual(result.items, []);
  assert.equal(result.review[0].reason, 'invalid-extraction');
});

test('reuses verified parent and occurrence IDs and withholds a conflicting same-day change', async () => {
  const [base] = (await preview()).items;
  base.id = 'previous-event-id';
  base.occurrences[0].id = 'previous-session-id';
  base.occurrences[0].endAt = '2026-11-21T03:00:00.000Z';
  delete base.occurrences[0].endTimeKnown;
  base.price = 15;
  const knownListings = new Map([[base.id, base]]);
  const [updated] = (await preview(single, context, { knownListings })).items;
  assert.equal(updated.id, base.id);
  assert.equal(updated.occurrences[0].id, 'previous-session-id');
  assert.equal(updated.occurrences[0].endAt, base.occurrences[0].endAt);
  assert.equal(updated.price, 15);
  const result = await preview(
    changed((e) => {
      e.schedule.dates[0].startTime = '20:00';
    }),
    context,
    { knownListings },
  );
  assert.equal(result.review[0].reason, 'ambiguous-existing-occurrence');
  assert.equal(base.occurrences[0].startAt, '2026-11-21T01:00:00.000Z');
});

test('withholds candidates that contradict a known identity or exhibition run', async () => {
  const [base] = (await preview()).items;
  const knownListings = new Map([[base.id, base]]);
  const conflict = await preview(single, context, {
    knownListings,
    identifyEvent: (url) => ({ eventUrl: url, sourceIdentity: 'another:concert' }),
  });
  assert.equal(conflict.review[0].reason, 'ambiguous-event-identity');
  base.runDates = { start: '2026-11-01', end: '2026-11-19' };
  const outside = await preview(single, context, { knownListings });
  assert.equal(outside.review[0].reason, 'conflicting-existing-run');
  assert.deepEqual(outside.items, []);
});

test('stores up to three published photos and keeps a stored cover on later runs', async () => {
  const e = example('photo and ticket links');
  const [withoutPhotos] = (await preview(e.result, e.context)).items;
  assert.deepEqual(withoutPhotos.images, []);
  assert.equal(withoutPhotos.ticketUrl, e.result.event.ticketUrl);
  const [stored] = (await preview(e.result, e.context, { photos: photoPolicy() })).items;
  assert.deepEqual(stored.images, [photo]);
  assert.equal(stored.imageCaption, undefined);
  assert.deepEqual(stored.sourceImages, [e.result.event.imageUrls[0]]);
  const knownListings = new Map([[stored.id, stored]]);
  const next = structuredClone(e);
  const newUrl = 'https://events.example.test/photos/other.png';
  next.context.documents[0].urls.push(newUrl);
  next.result.event.imageUrls.unshift(newUrl);
  let read = false;
  const kept = await preview(next.result, next.context, {
    knownListings,
    photos: photoPolicy({
      read: async () => {
        read = true;
        return png;
      },
    }),
  });
  assert.equal(read, false);
  assert.deepEqual(kept.items[0].images, [photo]);
  const broken = await preview(next.result, next.context, {
    photos: photoPolicy({
      read: async () => {
        throw Error('Unavailable');
      },
    }),
  });
  assert.equal(broken.status, 'partial');
  assert.equal(broken.failedPages[0].error, 'photo-enrichment-failed');
  let downloaded = false;
  const unsafe = await preview(next.result, next.context, {
    photos: photoPolicy({
      validateUrl: () => 'http://127.0.0.1/',
      read: async () => {
        downloaded = true;
      },
    }),
  });
  assert.equal(downloaded, false);
  assert.equal(unsafe.failedPages[0].error, 'photo-enrichment-failed');
});

test('missing venues use only explicit organization defaults, retaining page and existing venues', async () => {
  const { sources } = await import('../../lib/connectors.mjs');
  const missing = changed((event) => {
    event.venue = null;
  });
  for (const id of ['wag', 'manitoba-museum', 'fortwhyte', 'canada-life-centre', 'forks', 'park']) {
    const organization = sources.find((source) => source.id === id);
    const input = { ...context, source: id };
    const extra = { source: organization };
    const [item] = (await preview(missing, input, extra)).items;
    assert.equal(item.venue, organization.defaultVenue.name);
    assert.equal(item.address, organization.defaultVenue.address);
    assert.equal(item.extraction.venueFallback, 'source-location');
    assert.ok(!item.extraction.evidence.some((e) => e.quote === organization.defaultVenue.name));
    const [explicit] = (await preview(single, input, extra)).items;
    assert.equal(explicit.venue, 'QA Hall');
    assert.equal(explicit.address, '');
    assert.equal(explicit.extraction.venueFallback, undefined);
    const prior = { ...item, venue: 'Owner venue', address: 'Owner address' };
    const [retained] = (
      await preview(missing, input, { ...extra, knownListings: new Map([[item.id, prior]]) })
    ).items;
    assert.equal(retained.venue, 'Owner venue');
    assert.equal(retained.address, 'Owner address');
    const online = changed((event) => {
      event.venue = { name: null, address: null, online: true, quote: 'Online' };
    });
    const onlineContext = structuredClone(input);
    onlineContext.documents[0].text += ' Online';
    const [remote] = (await preview(online, onlineContext, extra)).items;
    assert.equal(remote.venue, 'Online');
    assert.equal(remote.address, '');
    assert.equal(remote.extraction.venueFallback, undefined);
  }
  for (const id of ['manitoba', 'tourism-winnipeg', 'manitoba-music']) {
    const aggregator = sources.find((s) => s.id === id) || { id, name: id };
    assert.equal(aggregator.defaultVenue, undefined);
    const result = await preview(missing, { ...context, source: id }, { source: aggregator });
    assert.equal(result.items.length, 0);
    assert.equal(result.review[0].reason, 'missing-title-or-venue');
  }
});
