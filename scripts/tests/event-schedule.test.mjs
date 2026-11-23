import test from 'node:test';
import assert from 'node:assert/strict';
import {
  availabilityOn,
  collectionWindow,
  materializeVisitingHours,
  normalizeOccurrence,
  zonedTimestamp,
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
test('sessions store UTC instants, keep the published time and get stable IDs', () => {
  const evening = normalizeOccurrence(
    { start: '2026-10-16T19:00:00-05:00', end: '2026-10-16T20:00:00-05:00' },
    event,
  );
  assert.equal(evening.startAt, '2026-10-17T00:00:00.000Z');
  assert.deepEqual([evening.start, evening.end], ['2026-10-16', '2026-10-16']);
  assert.match(evening.time, /7:00/);
  assert.equal(evening.status, 'active');
  // Same input, same ID; another showtime the same day gets its own.
  assert.equal(
    normalizeOccurrence({ start: '2026-10-16T19:00:00-05:00' }, event).id,
    normalizeOccurrence({ start: '2026-10-16T19:00:00-05:00' }, event).id,
  );
  assert.notEqual(
    normalizeOccurrence({ start: '2026-10-16T21:00:00-05:00' }, event).id,
    evening.id,
  );
  assert.throws(() => normalizeOccurrence({ start: '2026-02-30' }, event), /Invalid/);
  assert.throws(
    () => normalizeOccurrence({ start: '2026-10-16', url: 'ftp://example.test' }, event),
    /URL/,
  );
});

test('missing or partial coverage never means closed; cancelled and hidden sessions are not available', () => {
  const parent = {
    ...event,
    occurrences: [normalizeOccurrence({ start: '2026-10-20', status: 'cancelled' }, event)],
    scheduleCoverage: [{ from: '2026-10-01', to: '2026-11-30', complete: false, checkedAt: stamp }],
  };
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
  const base = { ...event, type: 'Place' };
  const { occurrences, coverage } = materializeVisitingHours(hours, base, collectionWindow(stamp));
  const place = { ...base, occurrences, scheduleCoverage: coverage };
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

test('full two-month windows cross years and selected dates are validated', () => {
  assert.deepEqual(collectionWindow('2026-12-31T23:00:00Z'), {
    from: '2026-12-01',
    to: '2027-01-31',
  });
  assert.equal(parseSearch(new URLSearchParams('date=2026-10-19')).date, '2026-10-19');
  assert.throws(() => parseSearch(new URLSearchParams('date=2026-02-30')));
});
