import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  collectWag,
  parseWagCalendar,
  parseWagDates,
  parseWagEvent,
  WAG_CALENDAR,
} from '../../lib/server/wag.mjs';
import { createWagFetcher, flareSolverrEndpoint, wagUrl } from '../../lib/server/flaresolverr.mjs';
const fixture = (name) =>
  readFileSync(new URL(`../fixtures/wag/${name}.html`, import.meta.url), 'utf8');
const calendar = fixture('calendar');
const event = fixture('event');
const entry = parseWagCalendar(calendar).entries[0];
const now = '2026-10-11T12:00:00Z';
const source = { id: 'wag', name: 'WAG–Qaumajuq', url: WAG_CALENDAR };
const empty = '<div id="returned-posts">Your search didn’t return any events.</div>';

test('WAG dates require a confirmed year, validate calendar days and retain ranges', () => {
  assert.deepEqual(parseWagDates("Nov 6 Nov 8 '26"), { start: '2026-11-06', end: '2026-11-08' });
  assert.deepEqual(parseWagDates('April 17–19, 2027'), { start: '2027-04-17', end: '2027-04-19' });
  assert.deepEqual(parseWagDates("Dec 30 Jan 2 '27"), { start: '2026-12-30', end: '2027-01-02' });
  assert.equal(parseWagDates('Apr 17'), null);
  assert.equal(parseWagDates("Feb 30 '26"), null);
});

test('calendar scopes cards and canonicalizes source URLs', () => {
  assert.equal(parseWagCalendar(calendar).entries.length, 1);
  assert.equal(entry.url, 'https://www.wag.ca/event/qa-art/');
  assert.equal(parseWagCalendar(calendar).pagination.total, 2);
  assert.equal(parseWagCalendar(empty).empty, true);
  assert.throws(() => parseWagCalendar('<html>Blocked</html>'), /layout changed/);
  assert.throws(
    () => parseWagCalendar(calendar.replace('data-total="2"', 'data-total="NaN"')),
    /pagination/,
  );
});

test('detail preserves admission restrictions and sold out, excludes contact/related content', () => {
  const { item } = parseWagEvent(event, entry, now);
  assert.equal(item.price, 10);
  assert.match(item.admission, /free for kids under 12/);
  assert.equal(item.availability, 'sold-out');
  assert.equal(item.status, 'active');
  assert.equal(item.start, '2026-11-06');
  assert.equal(item.end, '2026-11-08');
  assert.match(item.time, /Saturday & Sunday/);
  assert.doesNotMatch(item.description, /private@|Related event/);
  assert.equal(item.ticketUrl, 'https://tickets.example.test/event');
  assert.equal(item.category, 'Arts & culture');
  assert.equal(
    parseWagEvent(event.replace('Art weekend', 'A revised title'), entry, now).item.id,
    item.id,
  );
  assert.equal(parseWagEvent(event, entry, '2026-11-09T12:00:00Z').stale, true);
});

test('uncertain or contradictory dates are withheld; series remain undated', () => {
  assert.match(
    parseWagEvent(event.replace('Nov 6 - Nov 8', 'Nov 7 - Nov 8'), entry, now).review,
    /disagree/,
  );
  assert.match(
    parseWagEvent(event.replace('Nov 6 - Nov 8', 'Nov 31'), entry, now).review,
    /confirmed/,
  );
  assert.ok(parseWagEvent(event, { ...entry, when: 'Nov 6 - Nov 8' }, now).review);
  const sunday = event
    .replace('Nov 6 - Nov 8', 'Nov 15')
    .replace('Public event description.', 'The second Sunday of November.');
  assert.match(parseWagEvent(sunday, { ...entry, when: "Nov 15 '26" }, now).review, /recurrence/);
  const series = event
    .replace('Nov 6 - Nov 8', 'Multiple Dates/Ages Available')
    .replace('<p>SOLD OUT!</p>', '<p>Class A SOLD OUT! Class B available.</p>');
  const { item } = parseWagEvent(series, { ...entry, when: 'Multiple Dates/Ages Available' }, now);
  assert.equal(item.type, 'Activity');
  assert.equal(item.start, undefined);
  assert.equal(item.availability, 'unknown');
});

test('cancelled events are explicit and conditional free admission is not assumed free', () => {
  const cancelled = event.replace('Explore art by local makers.', 'This event has been cancelled.');
  assert.equal(parseWagEvent(cancelled, entry, now).item.status, 'cancelled');
  const noPrice = event
    .replace('$10 or free for kids under 12', '')
    .replace('Public event description.', 'Free admission for members.');
  assert.equal(parseWagEvent(noPrice, entry, now).item.price, null);
});

test('collector follows pagination, deduplicates URLs, records partial failures and bounds work', async () => {
  const calls = [];
  const second = calendar
    .replace('class="btn-more"', 'class="unused"')
    .replaceAll('qa-art/', 'qa-other/');
  const fetchPage = async (url) => {
    calls.push(url);
    return { body: url === WAG_CALENDAR ? calendar : url.includes('paged=2') ? second : event };
  };
  const full = await collectWag(source, now, { fetchPage, pauseMs: 0 });
  assert.equal(full.items.length, 2);
  assert.equal(full.failedPages.length, 0);
  assert.equal(full.pagesRead, 2);
  assert.equal(calls.length, 4);
  const partial = await collectWag(source, now, {
    pauseMs: 0,
    fetchPage: async (url) => ({
      body: url === WAG_CALENDAR ? calendar : url.includes('paged=2') ? empty : event,
    }),
  });
  assert.equal(partial.items.length, 1);
  assert.match(partial.failedPages[0].error, /no new events/);
  assert.equal(partial.allowEmpty, false);
  const limited = await collectWag(source, now, { fetchPage, pauseMs: 0, maxEvents: 1 });
  assert.equal(limited.items.length, 1);
  assert.match(limited.failedPages[0].error, /limit/);
  const noEvents = await collectWag(source, now, {
    pauseMs: 0,
    fetchPage: async () => ({ body: empty }),
  });
  assert.equal(noEvents.allowEmpty, true);
  await assert.rejects(
    collectWag(source, now, { pauseMs: 0, fetchPage: async () => ({ body: 'changed layout' }) }),
    /layout/,
  );
});

test('FlareSolverr restricts targets, sanitizes errors, rejects challenges and discards cookies', async () => {
  assert.throws(() => wagUrl('https://evil.test/event/a/'), /Refused/);
  assert.throws(() => wagUrl('https://www.wag.ca/wp-admin/'), /Refused/);
  assert.throws(() => flareSolverrEndpoint('http://user:secret@localhost:8191'), /credentials/);
  let request;
  const response = {
    status: 'ok',
    solution: { status: 200, url: entry.url, response: event, cookies: [{ value: 'SECRET' }] },
  };
  const fetcher = (data, options = {}) =>
    createWagFetcher({
      endpoint: 'http://localhost:8191/v1',
      fetchImpl: async (_, init) => {
        request = JSON.parse(init.body);
        return Response.json(data);
      },
      ...options,
    });
  const got = await fetcher(response)(entry.url);
  assert.deepEqual(Object.keys(got), ['url', 'body']);
  assert.equal(request.cmd, 'request.get');
  assert.equal(request.maxTimeout, 60000);
  await assert.rejects(
    fetcher({ status: 'error', message: 'SECRET' })(entry.url),
    /challenge or timeout/,
  );
  await assert.rejects(
    fetcher({
      ...response,
      solution: { ...response.solution, response: '<title>Just a moment...</title>' },
    })(entry.url),
    /verification/,
  );
  await assert.rejects(
    fetcher({ ...response, solution: { ...response.solution, url: 'https://evil.test/' } })(
      entry.url,
    ),
    /Refused/,
  );
  await assert.rejects(fetcher(response, { maxBytes: 20 })(entry.url), /size limit/);
  await assert.rejects(
    fetcher(response, {
      fetchImpl: async () => {
        throw Error('SECRET');
      },
    })(entry.url),
    /FlareSolverr fetch failed/,
  );
});

test('weekly classes retain their date span and exclusions without generating occurrences', () => {
  const html = event
    .replace('Nov 6 - Nov 8', 'Sep 20 - Nov 29*No Classes Oct 11')
    .replace('Friday | 11am-9pm', 'Sundays 12pm-1:30pm');
  const parsed = parseWagEvent(html, { ...entry, when: "Sep 20 Nov 29 '26" }, now);
  assert.equal(parsed.item.type, 'Activity');
  assert.equal(parsed.item.start, '2026-09-20');
  assert.equal(parsed.item.end, '2026-11-29');
  assert.match(parsed.item.description, /No Classes Oct 11/);
  assert.match(parsed.item.description, /Sundays/);
  const free = event
    .replace('$10 or free for kids under 12', '')
    .replace('Tickets coming soon!', '')
    .replace(
      'Explore art by local makers.',
      'Join us for free admission to WAG-Qaumajuq and family fun!',
    );
  assert.equal(parseWagEvent(free, entry, now).item.price, 0);
});
