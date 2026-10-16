import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEvents,
  availabilityOn,
  collectionWindow,
  materializeVisitingHours,
  zonedTimestamp,
  projectEvent,
} from '../../lib/event-schedule.mjs';
import { parseSearch } from '../../lib/server/search-query.mjs';
const stamp = '2026-10-16T12:00:00Z';
const event = {
  id: 'test-program',
  source: 'test',
  url: 'https://example.test/program/',
  title: 'Shared program',
  type: 'Event',
  schedule: 'series',
  description: 'One description',
  images: [],
  price: null,
  status: 'active',
  checkedAt: stamp,
};
const session = (id, day, time = '19:00:00-05:00') => ({
  ...event,
  id,
  seriesId: event.id,
  start: day,
  end: day,
  startAt: day + 'T' + time,
  endAt: day + 'T20:00:00-05:00',
  recurring: true,
  schedule: 'event',
  time: '7–8pm',
});

test('one event owns lightweight sessions; same URL/date showtimes remain separate and stable', () => {
  const raw = [
    session('test-first', '2026-10-16'),
    session('test-second', '2026-10-16', '18:00:00-05:00'),
  ];
  const [parent] = normalizeEvents(raw, stamp);
  assert.equal(parent.id, event.id);
  assert.equal(parent.description, 'One description');
  assert.equal(parent.occurrences.length, 2);
  assert.equal(parent.startAt, undefined);
  assert.equal(parent.start, undefined);
  assert.ok(
    parent.occurrences.every((o) => !('description' in o) && !('title' in o) && !('images' in o)),
  );
  assert.deepEqual(normalizeEvents([parent], stamp), [parent]);
  const cards = projectEvent(parent);
  assert.equal(cards.length, 2);
  assert.ok(cards.every((c) => c.eventId === event.id && c.schedule === 'event' && c.recurring));
  assert.notEqual(cards[0].id, cards[1].id);
});

test('timestamp storage uses UTC while preserving published source text and stable IDs', () => {
  const [parent] = normalizeEvents([session('test-offset', '2026-10-16')], stamp);
  const occurrence = parent.occurrences[0];
  assert.equal(occurrence.startAt, '2026-10-17T00:00:00.000Z');
  assert.equal(occurrence.publishedStart, '2026-10-16T19:00:00-05:00');
  assert.equal(occurrence.start, '2026-10-16');
  assert.equal(occurrence.timeZone, 'America/Winnipeg');
  assert.equal(occurrence.id, 'test-offset');
  assert.deepEqual(normalizeEvents([parent], stamp), [parent]);
});

test('exhibitions project a card per visiting day, preserving run bounds and availability', () => {
  const [paper] = normalizeEvents(
    [
      {
        ...event,
        occurrenceMode: 'continuous',
        runDates: { start: '2026-05-01', endMonth: '2027-04' },
        start: '2026-05-01',
        endMonth: '2027-04',
        occurrenceSamples: [
          { start: '2026-10-20T10:00:00-05:00', end: '2026-10-20T16:00:00-05:00', url: event.url },
          { start: '2026-10-21T10:00:00-05:00', end: '2026-10-21T16:00:00-05:00', url: event.url },
        ],
        scheduleCoverage: [
          { from: '2026-10-01', to: '2026-11-30', complete: true, checkedAt: stamp },
        ],
      },
    ],
    stamp,
  );
  assert.equal(projectEvent(paper).length, 2);
  assert.equal(paper.occurrenceMode, undefined);
  assert.ok(
    projectEvent(paper).every((c) => c.recurring && c.eventId === paper.id && c.start === c.end),
  );
  assert.equal(projectEvent(paper, { date: '2026-10-20' }).length, 1);
  assert.equal(availabilityOn(paper, '2026-10-19').status, 'unavailable');
  assert.equal(availabilityOn(paper, '2026-10-20').status, 'available');
  assert.equal(availabilityOn(paper, '2026-12-01').status, 'unknown');
  assert.equal(availabilityOn(paper, '2027-05-01').status, 'unavailable');
  assert.equal(paper.end, undefined);
  assert.equal(paper.endMonth, '2027-04');
  assert.equal(projectEvent(paper, { date: '2026-10-19' }).length, 0);
  assert.equal(
    projectEvent(paper, { date: '2026-10-20' })[0].visitAvailability.status,
    'available',
  );
});

test('missing or partial coverage never means closed; cancelled and hidden sessions are not available', () => {
  const [parent] = normalizeEvents(
    [
      {
        ...event,
        occurrences: [{ start: '2026-10-20', url: event.url, status: 'cancelled' }],
        scheduleCoverage: [
          { from: '2026-10-01', to: '2026-11-30', complete: false, checkedAt: stamp },
        ],
      },
    ],
    stamp,
  );
  assert.equal(availabilityOn(parent, '2026-10-20').status, 'unknown');
  parent.scheduleCoverage[0].complete = true;
  assert.equal(availabilityOn(parent, '2026-10-20').status, 'unavailable');
  parent.occurrences[0].status = 'active';
  parent.occurrences[0].hidden = true;
  assert.equal(availabilityOn(parent, '2026-10-20').status, 'unavailable');
  parent.occurrences[0].hidden = false;
  assert.equal(availabilityOn(parent, '2026-10-20').status, 'available');
  assert.equal(availabilityOn(parent, '2026-10-20').hoursKnown, false);
});

const hours = {
  timeZone: 'America/Winnipeg',
  sourceUrl: 'https://example.test/hours',
  checkedAt: stamp,
  periods: [
    {
      from: '2026-10-01',
      to: '2026-11-30',
      weekly: [{ weekdays: [2, 3, 4, 5, 6, 0], opens: '10:00', closes: '16:00' }],
    },
  ],
  exceptions: [
    { from: '2026-10-19', to: '2026-10-19', intervals: [{ opens: '12:00', closes: '17:00' }] },
    { from: '2026-11-11', to: '2026-11-11', closed: true },
  ],
};
test('verified place hours honor closed Mondays, exceptional openings, holiday closure and DST', () => {
  const [place] = normalizeEvents([{ ...event, type: 'Place', visitingSchedule: hours }], stamp);
  assert.equal(availabilityOn(place, '2026-10-26').status, 'unavailable');
  assert.equal(availabilityOn(place, '2026-10-19').status, 'available');
  assert.equal(availabilityOn(place, '2026-11-11').status, 'unavailable');
  assert.equal(availabilityOn(place, '2026-12-01').status, 'unknown');
  assert.equal(
    place.occurrences.find((o) => o.start === '2026-10-20').startAt,
    '2026-10-20T15:00:00.000Z',
  );
  assert.equal(
    place.occurrences.find((o) => o.start === '2026-11-03').startAt,
    '2026-11-03T16:00:00.000Z',
  );
  assert.equal(projectEvent(place).length, 1);
});

test('a dated closure overrides a broader special opening; conflicting rules fail safely', () => {
  const schedule = {
    ...hours,
    exceptions: [
      { from: '2026-10-01', to: '2026-10-31', intervals: [{ opens: '10:00', closes: '18:00' }] },
      { from: '2026-10-19', to: '2026-10-19', closed: true },
    ],
  };
  const materialized = materializeVisitingHours(schedule, event, collectionWindow(stamp));
  assert.equal(
    materialized.occurrences.some((o) => o.start === '2026-10-19'),
    false,
  );
  assert.throws(
    () =>
      materializeVisitingHours(
        { ...hours, periods: [...hours.periods, ...hours.periods] },
        event,
        collectionWindow(stamp),
      ),
    /Overlapping/,
  );
  assert.throws(() => zonedTimestamp('2026-03-08', '02:30'), /does not exist/);
});

test('bounded weekly class schedules honor explicitly printed no-class dates', () => {
  const [classes] = normalizeEvents(
    [
      {
        ...event,
        start: '2026-09-20',
        end: '2026-11-29',
        scheduleText: 'September 20 – November 29 · No classes Oct 11 · Sundays Ages 9–11',
        time: '1–3pm',
      },
    ],
    stamp,
  );
  assert.ok(classes.occurrences.length > 0);
  assert.equal(
    classes.occurrences.some((o) => o.start === '2026-10-11'),
    false,
  );
  assert.ok(classes.occurrences.every((o) => o.start >= '2026-10-01' && o.start <= '2026-11-30'));
  assert.equal(availabilityOn(classes, '2026-10-18').status, 'available');
  assert.equal(availabilityOn(classes, '2026-10-19').status, 'unknown');
  const [unknown] = normalizeEvents(
    [{ ...event, start: '2026-09-20', end: '2026-11-29', scheduleText: 'Dates vary' }],
    stamp,
  );
  assert.equal(unknown.occurrences.length, 0);
});

test('full two-month windows cross years and selected dates are validated', () => {
  assert.deepEqual(collectionWindow('2026-12-31T23:00:00Z'), {
    from: '2026-12-01',
    to: '2027-01-31',
  });
  assert.equal(parseSearch(new URLSearchParams('date=2026-10-19')).date, '2026-10-19');
  assert.throws(() => parseSearch(new URLSearchParams('date=2026-02-30')));
});
