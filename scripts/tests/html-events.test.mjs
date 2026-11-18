import test from 'node:test';
import assert from 'node:assert/strict';
import { sources, parseSource } from '../../lib/connectors.mjs';
import { collectHtmlEvents, htmlEventUrl } from '../../lib/server/html-events.mjs';
import { prepareExtractionContext } from '../../lib/server/event-page-preparation.mjs';

const source = sources.find((s) => s.id === 'forks');
const now = '2026-11-17T12:00:00Z';
const card = (id, date = 'Fri, Nov 20') => `<div class="event-listing">
  <h3>Community Concert ${id}</h3><p class="dates">${date}</p>
  <p>A public concert.</p><p class="hours">7 PM</p>
  <a href="/events/calendar-of-events/event/${id}">See More</a></div>`;
const home = card(1) + card(2, 'Sat, Jan 2');
const privatePhoto = '/api/photos/' + 'a'.repeat(64);

test('Forks accepts old linked headings and current See More buttons with the same identity', () => {
  const current = parseSource('forks', card(1), now)[0];
  const old = parseSource(
    'forks',
    card(1).replace(
      '<h3>Community Concert 1</h3>',
      '<h3><a href="/events/calendar-of-events/event/1">Community Concert 1</a></h3>',
    ),
    now,
  )[0];
  assert.equal(current.id, old.id);
  assert.equal(current.title, old.title);
  assert.match(current.url, /\/event\/1$/);
});

test('HTML off mode fetches no extraction details and bounds parser fallbacks to two months', async () => {
  const requests = [];
  const result = await collectHtmlEvents(source, now, {
    pauseMs: 0,
    fetchImpl: async (url) => {
      requests.push(url);
      return new Response(home);
    },
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].start, '2026-11-20');
  assert.ok(requests.every((url) => !/\/event\//.test(url)));
});

test('HTML enrichment scopes source evidence, privately stores photos, and reuses them', async () => {
  const pages = [],
    requests = [];
  let writes = 0;
  const options = {
    pauseMs: 0,
    onEventPage: (page) => pages.push(page),
    fetchImpl: async (url) => {
      requests.push(url);
      return new Response(
        url.includes('/uploads/')
          ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
          : url.includes('/event/')
            ? '<nav>Unrelated event</nav><main><h1>Community Concert 1</h1><p>November 20, 2026 at 7 PM</p><img src="/uploads/concert.png"></main>'
            : home,
      );
    },
    storePhoto: async () => {
      writes++;
      return privatePhoto;
    },
  };
  const result = await collectHtmlEvents(source, now, options);
  assert.equal(pages.length, 1);
  assert.deepEqual(result.items[0].images, [privatePhoto]);
  const context = prepareExtractionContext({
    source: source.id,
    pageUrl: pages[0].url,
    checkedAt: now,
    pages: [pages[0], ...pages[0].supportingPages],
  });
  assert.match(context.documents[0].text, /November 20, 2026 at 7 PM/);
  assert.doesNotMatch(context.documents[0].text, /Unrelated/);
  await collectHtmlEvents(source, now, {
    ...options,
    knownListings: new Map(result.items.map((item) => [item.id, item])),
  });
  assert.equal(writes, 1);
});

test('a date parser miss is hidden until supported extraction, and detail failures retain the parser', async () => {
  const pages = [];
  const result = await collectHtmlEvents(source, now, {
    pauseMs: 0,
    onEventPage: (page) => pages.push(page),
    fetchImpl: async (url) =>
      new Response(
        url.includes('/event/')
          ? '<main>Concert. Dates to be announced.</main>'
          : card(1, 'Dates TBA'),
      ),
  });
  assert.equal(result.items[0].status, 'hidden');
  assert.equal(result.items[0].type, 'Activity');
  assert.equal(pages[0].dateReview, true);
  const failed = await collectHtmlEvents(source, now, {
    pauseMs: 0,
    onEventPage: () => assert.fail(),
    fetchImpl: async (url) =>
      new Response(url.includes('/event/') ? 'Unavailable' : home, {
        status: url.includes('/event/') ? 503 : 200,
      }),
  });
  assert.equal(failed.items[0].title, 'Community Concert 1');
  assert.equal(failed.eventPageFailures, 1);
});

test('HTML URL policy refuses external pages, credentials, non-event paths and decorative media', () => {
  for (const url of [
    'https://evil.test/events/a',
    'https://user@www.theforks.com/events/a',
    'https://www.theforks.com/contact',
  ])
    assert.throws(() => htmlEventUrl(source, url), /Refused/);
  assert.throws(() => htmlEventUrl(source, '/img/logo.svg', 'photo'), /Refused/);
});

test('Forks retains each month interval for a repeated URL and uses calendar dates over broad detail ranges', async () => {
  const pages = [];
  const result = await collectHtmlEvents(source, now, {
    pauseMs: 0,
    onEventPage: (page) => pages.push(page),
    fetchImpl: async (url) =>
      new Response(
        url.includes('/event/')
          ? '<main>Concert October 1 to December 31</main>'
          : url.includes('2026/12')
            ? card(1, 'Fri, Dec 4')
            : card(1),
      ),
  });
  assert.equal(pages[0].calendarSchedule, 'dates');
  assert.deepEqual(
    result.items[0].occurrences.map((o) => o.start),
    ['2026-11-20', '2026-12-04'],
  );
  assert.equal(new Set(result.items[0].occurrences.map((o) => o.id)).size, 2);
});
