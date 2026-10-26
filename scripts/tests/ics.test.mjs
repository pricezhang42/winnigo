import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseIcsEvents } from '../../lib/server/ics.mjs';
import {
  parseClcFeed,
  collectClc,
  compareClcCalendar,
  clcEventUrl,
} from '../../lib/server/canada-life-centre.mjs';
import { normalizeEvents, projectEvent } from '../../lib/event-schedule.mjs';
import { listingDedupeKey } from '../../lib/connectors.mjs';
const text = await readFile('scripts/fixtures/clc/calendar.ics', 'utf8');
const checkedAt = '2026-10-16T12:00:00Z',
  window = { from: '2026-10-01', to: '2026-11-30' };
const wrap = (body) => `BEGIN:VCALENDAR\nVERSION:2.0\n${body}\nEND:VCALENDAR`;

test('bounded ICS parsing preserves DST, exclusions, moved/cancelled instances, all-day and floating precision', () => {
  const result = parseIcsEvents(text, window);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.events.length, 6);
  const series = result.events.find((e) => e.uid === 'weekly@example.test');
  assert.equal(series.occurrences.length, 5);
  const oct = series.occurrences.find((o) => o.start === '2026-10-25');
  assert.equal(oct.startAt, '2026-10-26T00:00:00.000Z');
  const moved = series.occurrences.find((o) => o.start === '2026-11-09');
  assert.equal(moved.startAt, '2026-11-10T02:00:00.000Z');
  assert.equal(moved.recurrenceKey, '2026-11-09T01:00:00.000Z');
  assert.equal(moved.title, 'Rescheduled concert');
  assert.equal(series.occurrences.find((o) => o.start === '2026-11-01').status, 'cancelled');
  assert.equal(series.occurrences.find((o) => o.start === '2026-11-15').status, 'cancelled');
  const day = result.events.find((e) => e.uid === 'all-day@example.test').occurrences[0];
  assert.equal(day.start, '2026-10-19');
  assert.equal(day.end, '2026-10-20');
  assert.equal(day.startAt, undefined);
  assert.equal(
    result.events.find((e) => e.uid === 'utc@example.test').occurrences[0].start,
    '2026-10-31',
  );
  assert.equal(
    result.events.find((e) => e.uid === 'floating@example.test').occurrences[0].startAt,
    '2026-10-23T00:00:00.000Z',
  );
});

test('UIDs distinguish same-day same-URL performances; overrides use shared lightweight source exceptions', () => {
  const result = parseClcFeed(text, checkedAt);
  assert.equal(result.failedPages.length, 0);
  const items = normalizeEvents(result.items, checkedAt),
    shows = items.filter((e) => e.title === 'Same-day show');
  assert.equal(shows.length, 2);
  assert.notEqual(shows[0].id, shows[1].id);
  assert.notEqual(listingDedupeKey(shows[0]), listingDedupeKey(shows[1]));
  assert.equal(
    items.find((e) => e.title === 'Synthetic floating event').occurrences[0].endTimeKnown,
    false,
  );
  const series = items.find((e) => e.title === 'Concert series');
  const cards = projectEvent(series);
  assert.equal(cards.length, 3);
  assert.equal(cards.find((e) => e.start === '2026-11-09').title, 'Rescheduled concert');
  assert.ok(series.occurrences.every((o) => !o.title && !o.description));
  assert.equal(
    series.occurrences.find((o) => o.start === '2026-11-09').sourceOverrides.title,
    'Rescheduled concert',
  );
});

test('RDATE-only schedules, multiple RDATE lines, PERIOD values and exact same-day exclusions', () => {
  const r = parseIcsEvents(
    wrap(
      `BEGIN:VEVENT\nUID:r\nDTSTART;TZID=America/Winnipeg:20261020T190000\nDTEND;TZID=America/Winnipeg:20261020T200000\nRDATE;TZID=America/Winnipeg:20261020T210000\nRDATE;TZID=America/Winnipeg;VALUE=PERIOD:20261021T190000/PT2H\nEXDATE;TZID=America/Winnipeg:20261020T190000\nSUMMARY:RDATE\nEND:VEVENT`,
    ),
    window,
  );
  assert.equal(r.rejected.length, 0);
  const dates = r.events[0].occurrences;
  assert.equal(dates.length, 3);
  assert.equal(dates.filter((o) => o.status === 'active').length, 2);
  assert.equal(dates.find((o) => o.start === '2026-10-21').endAt, '2026-10-22T02:00:00.000Z');
});

test('unbounded, malformed and unsupported calendars fail safely; irrelevant history is ignored', async () => {
  assert.throws(() => parseIcsEvents(text, { from: '2026-01-01', to: '2027-01-01' }), /horizon/);
  assert.throws(() => parseIcsEvents(text.replace('END:VCALENDAR', ''), window), /Incomplete/);
  assert.throws(
    () => parseIcsEvents(text.replace('America/Winnipeg', 'Unknown/Zone'), window),
    /time zone/i,
  );
  const bad = wrap(
    'BEGIN:VEVENT\nUID:bad\nDTSTART:20261020T190000Z\nDTEND:20261020T180000Z\nSUMMARY:Bad date\nEND:VEVENT',
  );
  assert.equal(parseClcFeed(bad, checkedAt).failedPages.length, 1);
  const high = text.replace('FREQ=WEEKLY;COUNT=4', 'FREQ=SECONDLY');
  assert.match(parseIcsEvents(high, window).rejected[0].error, /density/);
  await assert.rejects(
    collectClc({}, checkedAt, { fetchImpl: async () => new Response('Down', { status: 503 }) }),
    /HTTP 503/,
  );
  await assert.rejects(
    collectClc({}, checkedAt, { fetchImpl: async () => new Response('<html>Blocked</html>') }),
    /ICS calendar/,
  );
  const empty = await collectClc({}, checkedAt, { fetchImpl: async () => new Response(wrap('')) });
  assert.equal(empty.allowEmpty, true);
  assert.throws(() => clcEventUrl('https://evil.test/calendar-events/a/'), /Refused/);
});

test('calendar comparison uses independently published Winnipeg wall times across DST', () => {
  const r = parseClcFeed(
    wrap(
      'BEGIN:VEVENT\nUID:a\nDTSTART;TZID=America/Winnipeg:20261102T190000\nDTEND;TZID=America/Winnipeg:20261102T210000\nSUMMARY:Show\nURL:https://www.canadalifecentre.ca/calendar-events/show/\nEND:VEVENT',
    ),
    checkedAt,
  );
  const json = JSON.stringify({
    R: 'OK',
    EVENTS: [
      {
        start: '2026-11-02 19:00:00',
        end: '2026-11-02 21:00:00',
        url: 'https://www.canadalifecentre.ca/calendar-events/show/',
        allDay: false,
      },
    ],
  });
  assert.deepEqual(compareClcCalendar(r, json), {
    feed: 1,
    calendar: 1,
    feedOnly: [],
    calendarOnly: [],
    differentEnds: [],
  });
});

test('calendar floating zone and explicit UTC instants still filter and display in Winnipeg', () => {
  const r = parseIcsEvents(
    wrap(
      'X-WR-TIMEZONE:Europe/London\nBEGIN:VEVENT\nUID:zone\nDTSTART:20261102T190000\nDTEND:20261102T200000\nSUMMARY:Different zone\nEND:VEVENT',
    ),
    window,
  );
  assert.equal(r.events[0].occurrences[0].startAt, '2026-11-02T19:00:00.000Z');
  assert.equal(r.events[0].occurrences[0].timeZone, 'America/Winnipeg');
  assert.match(r.events[0].occurrences[0].time, /1:00/);
});
