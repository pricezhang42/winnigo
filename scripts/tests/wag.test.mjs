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
  assert.equal(
    parseWagEvent(event, { ...entry, when: 'Nov 6 - Nov 8' }, now).item.start,
    '2026-11-06',
  );
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
    .replace(
      'Nov 6 - Nov 8',
      'Sep 20 - Nov 29<div class="date-details">*No Classes Oct 11<br>Sundays</div><div class="age-range">Ages 6-8</div>',
    )
    .replace('Friday | 11am-9pm', '<strong>12pm-1:30pm</strong>');
  const parsed = parseWagEvent(html, { ...entry, when: "Sep 20 Nov 29 '26" }, now);
  assert.equal(parsed.item.type, 'Activity');
  assert.equal(parsed.item.start, '2026-09-20');
  assert.equal(parsed.item.end, '2026-11-29');
  assert.match(parsed.item.scheduleText, /No classes Oct 11/);
  assert.doesNotMatch(parsed.item.description, /No classes|Sundays/i);
  const free = event
    .replace('$10 or free for kids under 12', '')
    .replace('Tickets coming soon!', '')
    .replace(
      'Explore art by local makers.',
      'Join us for free admission to WAG-Qaumajuq and family fun!',
    );
  assert.equal(parseWagEvent(free, entry, now).item.price, 0);
});

test('event galleries cap at three distinct photos and exclude unrelated or unsafe images', () => {
  const base = 'https://www.wag.ca/isl/uploads/2026/10/';
  const html = event
    .replace(
      '<main>',
      `<meta property="og:image" content="${base}cover-scaled.jpg"><main><div class="event-featured-img" style="background-image: url('${base}cover-scaled-2000x1000.jpg')"></div>`,
    )
    .replace(
      'Public event description.',
      `Public event description.
      <img src="${base}sponsor-logo.jpg"><a href="https://sponsor.test"><img src="${base}business.jpg"></a>
      <img src="https://other.test/photo.jpg"><img src="data:image/png;base64,abc">
      <div class="story-card"><img src="${base}unrelated.jpg"></div>
      <a href="${base}second.jpg"><img src="${base}second-300x200.jpg"></a>
      <img data-src="${base}third.webp" src="placeholder.gif"><img src="${base}fourth.png">`,
    );
  const { item } = parseWagEvent(html, entry, now);
  assert.deepEqual(item.images, [
    base + 'cover-scaled-2000x1000.jpg',
    base + 'second.jpg',
    base + 'third.webp',
  ]);
  assert.equal(item.image, item.images[0]);
  assert.deepEqual(parseWagEvent(event, entry, now).item.images, []);
});

test('photo downloads validate origin and bytes, and forward only WAG session cookies', async () => {
  const { fetchWagPhoto } = await import('../../lib/server/wag-photos.mjs');
  const url = 'https://www.wag.ca/isl/uploads/2026/10/art.jpg';
  const session = {
    userAgent: 'Test browser',
    url: entry.url,
    cookies: [
      { domain: '.wag.ca', name: 'clearance', value: 'secret' },
      { domain: 'other.test', name: 'foreign', value: 'excluded' },
    ],
  };
  let headers;
  const options = {
    container: '',
    fetchImpl: async (_, init) => {
      headers = init.headers;
      return new Response(new Uint8Array([255, 216, 255, 0]));
    },
  };
  assert.equal((await fetchWagPhoto(url, session, options)).contentType, 'image/jpeg');
  assert.equal(headers.Cookie, 'clearance=secret');
  await assert.rejects(fetchWagPhoto('https://other.test/a.jpg', session, options), /Refused/);
  await assert.rejects(
    fetchWagPhoto(url, session, {
      ...options,
      fetchImpl: async () => new Response('<html>challenge</html>'),
    }),
    /supported image/,
  );
  await assert.rejects(
    fetchWagPhoto(url, session, {
      ...options,
      fetchImpl: async () => new Response('', { status: 403 }),
    }),
    /HTTP 403/,
  );
});

test('saved collection replaces source URLs with stored photos and withholds failed photo imports', async () => {
  const html =
    '<meta property="og:image" content="https://www.wag.ca/isl/uploads/2026/10/art.jpg">' + event;
  const fetchPage = async (url) => ({
    body: url === WAG_CALENDAR ? calendar.replace('class="btn-more"', 'class="unused"') : html,
  });
  fetchPage.fetchPhoto = async () => ({
    bytes: new Uint8Array([255, 216, 255]),
    contentType: 'image/jpeg',
  });
  const stored = '/api/photos/' + 'a'.repeat(64);
  const good = await collectWag(source, now, {
    fetchPage,
    pauseMs: 0,
    storePhoto: async () => stored,
  });
  assert.deepEqual(good.items[0].images, [stored]);
  assert.equal(good.items[0].image, stored);
  assert.match(good.items[0].sourceImages[0], /^https:\/\/www.wag.ca/);
  fetchPage.fetchPhoto = async () => {
    throw Error('Private upstream details');
  };
  const bad = await collectWag(source, now, {
    fetchPage,
    pauseMs: 0,
    storePhoto: async () => stored,
  });
  assert.equal(bad.items.length, 0);
  assert.equal(bad.allowEmpty, false);
  assert.match(bad.failedPages[0].error, /photos unavailable/);
  assert.doesNotMatch(JSON.stringify(bad), /Private upstream/);
});

const classPage = event
  .replace(
    'Nov 6 - Nov 8',
    'Sep 20 - Nov 29<div>*No Classes Oct 11<br>Sundays</div><div>Ages 9-11</div>',
  )
  .replace('Friday | 11am-9pm', '2pm-3:30pm');
const classParent = event.replace('Nov 6 - Nov 8', 'Multiple Dates/Ages Available').replace(
  '<div class="widget"><p>SOLD OUT!</p>',
  `<div class="widget"><h3>Choose from:</h3>
    <a href="/event/class-a">Class A</a><a href="/event/class-a/?ref=duplicate">Class A</a>
    <a href="/event/class-b/">Class B</a><a href="https://other.test/event/class-c/">External</a>
    <a href="/event/qa-art/">Self</a></div><div class="widget"><p>SOLD OUT!</p>`,
);
const classCalendar = calendar
  .replace('class="btn-more"', 'class="unused"')
  .replace("Nov 6 Nov 8 '26", 'Multiple Dates/Ages Available');

test('class discovery is scoped to the parent choice widget and canonicalizes links', async () => {
  const { parseWagClassOptions } = await import('../../lib/server/wag.mjs');
  assert.deepEqual(
    parseWagClassOptions(classParent, entry.url).map((o) => o.url),
    ['https://www.wag.ca/event/class-a/', 'https://www.wag.ca/event/class-b/'],
  );
  assert.deepEqual(parseWagClassOptions(event, entry.url), []);
});

test('missing years default to the current Winnipeg year; printed years take precedence', () => {
  const child = { ...entry, when: 'Class A', parentUrl: entry.url };
  const { item } = parseWagEvent(classPage, child, now);
  assert.equal(item.start, '2026-09-20');
  assert.equal(item.end, '2026-11-29');
  assert.equal(item.yearAssumed, true);
  assert.equal(item.schedule, 'series');
  assert.match(item.scheduleText, /No classes Oct 11/);
  assert.doesNotMatch(item.description, /Year unconfirmed|No classes|Sundays/i);
  assert.ok(parseWagEvent(classPage.replace('Sep 20 - Nov 29', 'Feb 30'), child, now).review);
  const explicit = parseWagEvent(classPage, { ...child, when: "Sep 20 Nov 29 '27" }, now).item;
  assert.equal(explicit.start, '2027-09-20');
  assert.equal(explicit.yearAssumed, undefined);
  const detailYear = parseWagEvent(
    classPage.replace('Nov 29', 'Nov 29, 2027'),
    { ...child, when: 'Sep 20 - Nov 29' },
    now,
  ).item;
  assert.equal(detailYear.start, '2027-09-20');
  assert.equal(detailYear.yearAssumed, undefined);
  const newYear = classPage.replace('Sep 20 - Nov 29', 'Dec 31');
  assert.equal(parseWagEvent(newYear, child, '2027-01-01T01:00:00Z').item.start, '2026-12-31');
  assert.equal(parseWagEvent(newYear, child, '2027-01-01T12:00:00Z').item.start, '2027-12-31');
});

test('collection follows class choices once, bounds child requests and preserves partial successes', async () => {
  const calls = [];
  const fetchPage = async (url) => {
    calls.push(url);
    return {
      body: url === WAG_CALENDAR ? classCalendar : url === entry.url ? classParent : classPage,
    };
  };
  const result = await collectWag(source, now, { fetchPage, pauseMs: 0 });
  assert.equal(result.items.length, 2);
  assert.equal(result.discovered, 3);
  assert.equal(result.eventPagesRead, 3);
  assert.equal(result.failedPages.length, 0);
  assert.equal(new Set(calls).size, calls.length);
  assert.deepEqual(result.supersededUrls, [entry.url]);
  assert.ok(result.items.every((item) => item.url !== entry.url));
  assert.equal(result.items[1].parentUrl, entry.url);
  assert.equal(result.items[0].yearAssumed, true);
  const repeat = await collectWag(source, now, { fetchPage, pauseMs: 0 });
  assert.deepEqual(
    repeat.items.map((i) => i.id),
    result.items.map((i) => i.id),
  );
  const limited = await collectWag(source, now, { fetchPage, pauseMs: 0, maxEvents: 2 });
  assert.equal(limited.eventPagesRead, 2);
  assert.match(limited.failedPages[0].error, /limit/);
  const partial = await collectWag(source, now, {
    pauseMs: 0,
    fetchPage: async (url) => {
      if (url.endsWith('/class-b/')) throw Error('Unavailable');
      return fetchPage(url);
    },
  });
  assert.equal(partial.items.length, 1);
  assert.equal(partial.eventPageFailures, 1);
  assert.equal(partial.allowEmpty, false);
});

test('a child already listed before its parent retains calendar dates and is fetched once', async () => {
  const card = `<a class="event-card" href="/event/class-a/"><h3>Class A</h3><div class="event-date">Sep 20 Nov 29 '26</div></a>`;
  const calls = [];
  const result = await collectWag(source, now, {
    pauseMs: 0,
    fetchPage: async (url) => {
      calls.push(url);
      return {
        body:
          url === WAG_CALENDAR
            ? classCalendar.replace('<div id="returned-posts">', '<div id="returned-posts">' + card)
            : url === entry.url
              ? classParent
              : classPage,
      };
    },
  });
  assert.equal(result.items.length, 2);
  const child = result.items.find((i) => i.url.endsWith('/class-a/'));
  assert.equal(child.parentUrl, entry.url);
  assert.equal(child.start, '2026-09-20');
  assert.equal(calls.filter((url) => url === child.url).length, 1);
});

test('discovery-only parents do not block a valid all-past empty collection', async () => {
  const result = await collectWag(source, '2026-12-15T12:00:00Z', {
    pauseMs: 0,
    fetchPage: async (url) => ({
      body: url === WAG_CALENDAR ? classCalendar : url === entry.url ? classParent : classPage,
    }),
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.skippedPast, 2);
  assert.deepEqual(result.supersededUrls, [entry.url]);
  assert.equal(result.allowEmpty, true);
});
