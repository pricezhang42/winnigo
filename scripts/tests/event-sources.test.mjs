import assert from 'node:assert/strict';
import test from 'node:test';
import { EVENT_SOURCES } from '../../config/sources.mjs';
import { parseEventExtraction } from '../../lib/contracts/event-extraction.mjs';
import {
  cityMatch,
  eventKey,
  crawlSource,
  extractPages,
  sourceUrl,
  validateSource,
  validateSources,
} from '../../lib/server/event-sources.mjs';
import { prepareExtractionContext } from '../../lib/server/event-page-preparation.mjs';
import { single } from '../fixtures/event-extraction.mjs';

const origin = 'https://events.example.test';
const organizer = 'https://organizer.example.test';
const checkedAt = '2026-11-06T18:00:00Z';
const base = {
  id: 'qa-events',
  name: 'QA Events',
  status: 'active',
  schedule: 'manual',
  fetch: {
    method: 'pages',
    allowedOrigin: origin,
    startUrls: [origin + '/events'],
    eventLinkPattern: '^/event/\\d+(?:/[^/]+)?$',
    eventKeyPattern: '^/event/(\\d+)',
    nextLinkPattern: '^/events/page/\\d+$',
    maxListPages: 3,
    maxEventPages: 10,
    selector: 'main',
  },
  supportingPages: { maxPerPage: 1, sites: [{ origin: organizer, pattern: '^/shows/[^/]+$' }] },
};
const variant = (change) => {
  const d = structuredClone(base);
  change(d);
  return d;
};

test('the checked-in source list is valid and every id is unique', () => {
  const configs = validateSources(EVENT_SOURCES);
  assert.ok(configs.length >= 10);
  assert.throws(() => validateSources([base, base]), /defined twice/);
});

test('definitions with an unsafe or incomplete scope are refused', () => {
  const refused = [
    (d) => (d.id = 'Bad Id'),
    (d) => (d.status = 'live'),
    (d) => (d.schedule = 'hourly'),
    (d) => (d.fetch.method = 'rss'),
    (d) => (d.fetch.allowedOrigin = 'http://events.example.test'),
    (d) => (d.fetch.allowedOrigin = origin + '/events'),
    (d) => (d.fetch.eventLinkPattern = '/event/'),
    (d) => delete d.fetch.eventLinkPattern,
    (d) => (d.fetch.eventKeyPattern = '^/event/\\d+'),
    (d) => (d.fetch.maxEventPages = 101),
    (d) => (d.fetch.startUrls = ['https://other.example.test/events']),
    (d) => (d.supportingPages.sites[0].pattern = 'shows'),
    (d) => (d.extraction = { maxOutputTokens: 100000 }),
    (d) => {
      d.fetch.method = 'single-page';
      delete d.fetch.eventLinkPattern;
    },
  ];
  for (const change of refused) assert.throws(() => validateSource(variant(change)));
  const listing = variant((d) => {
    d.fetch.method = 'single-page';
    delete d.fetch.eventLinkPattern;
    delete d.supportingPages;
  });
  assert.equal(validateSource(listing).maxEventPages, 0);
});

test('URLs stay on the source and supporting origins, without credentials', () => {
  const config = validateSource(base);
  assert.equal(sourceUrl(config, '/event/1#top'), origin + '/event/1');
  assert.equal(sourceUrl(config, organizer + '/shows/a'), organizer + '/shows/a');
  assert.throws(() => sourceUrl(config, 'https://elsewhere.example.test/event/1'));
  assert.throws(() => sourceUrl(config, `https://user:pw@events.example.test/event/1`));
  assert.throws(() => sourceUrl(config, 'http://events.example.test/event/1'));
});

function site(pages) {
  const requested = [];
  const fetchImpl = async (url, init) => {
    requested.push(String(url));
    assert.equal(init.redirect, 'manual');
    const page = pages[String(url)];
    if (page === undefined) return new Response('missing', { status: 404 });
    return new Response(page, { status: 200 });
  };
  return { requested, fetchImpl };
}

const eventHtml = (extra = '') =>
  `<main><h1>QA Concert</h1><p>November 20, 2026 at 7 PM</p><p>QA Hall</p>${extra}</main>`;

test('the pages crawler follows next links, merges links by key and fetches supporting pages', async () => {
  const { requested, fetchImpl } = site({
    [origin + '/events']: `
      <a href="/event/1/qa-concert">A</a><a href="/event/1">same event</a>
      <a href="https://elsewhere.example.test/event/9">off site</a>
      <a href="/about">About</a><a class="next" href="/events/page/2">Next</a>`,
    [origin + '/events/page/2']: `<a href="/event/2">B</a><a rel="next" href="/other/3">Next</a>`,
    [origin + '/event/1/qa-concert']: eventHtml(
      `<a href="${organizer}/shows/qa">Organizer</a><a href="${organizer}/about">x</a>`,
    ),
    [origin + '/event/2']: eventHtml(`<a href="${organizer}/shows/missing">Organizer</a>`),
    [organizer + '/shows/qa']: '<main><p>November 20, 2026 at 7 PM</p></main>',
  });
  const crawl = await crawlSource(base, { fetchImpl, pauseMs: 0 });
  assert.equal(crawl.listPagesRead, 2);
  assert.equal(crawl.discovered, 2);
  assert.deepEqual(
    crawl.pages.map((p) => [p.url, p.kind, p.supporting.map((s) => [s.url, !s.error])]),
    [
      [origin + '/event/1/qa-concert', 'event', [[organizer + '/shows/qa', true]]],
      [origin + '/event/2', 'event', [[organizer + '/shows/missing', false]]],
    ],
  );
  assert.ok(!requested.some((u) => u.includes('elsewhere') || u.includes('/other/')));
});

test('single-page sources read list pages as listings; inactive and browser sources do not run', async () => {
  const listing = variant((d) => {
    d.fetch.method = 'single-page';
    delete d.fetch.eventLinkPattern;
    delete d.supportingPages;
  });
  const { fetchImpl } = site({
    [origin + '/events']: '<main>Nov 20 Concert</main><a href="/events/page/2">Next</a>',
    [origin + '/events/page/2']: '<main>Dec 4 Concert</main>',
  });
  const crawl = await crawlSource(listing, { fetchImpl, pauseMs: 0 });
  assert.deepEqual(
    crawl.pages.map((p) => [p.url, p.kind]),
    [
      [origin + '/events', 'listing'],
      [origin + '/events/page/2', 'listing'],
    ],
  );
  for (const change of [(d) => (d.status = 'blocked'), (d) => (d.fetch.method = 'browser')])
    await assert.rejects(crawlSource(variant(change), { fetchImpl, pauseMs: 0 }));
});

const model = (change = () => {}) => {
  const value = structuredClone(single);
  change(value.events[0], value);
  return value;
};
const stubExtractor = (byUrl) => ({
  async extract(context) {
    const result = byUrl[context.pageUrl];
    if (result instanceof Error) throw result;
    return { result: result(context), estimatedCostUsd: 0.001 };
  },
});

test('extraction keeps events with sessions in the window, counts the rest and records failures', async () => {
  const crawl = {
    pages: [
      {
        url: origin + '/event/1',
        kind: 'event',
        html: eventHtml(),
        supporting: [
          { url: organizer + '/shows/qa', html: '<main><p>Doors 6 PM</p></main>' },
          { url: organizer + '/shows/empty', html: '<main></main>' },
          { url: organizer + '/shows/down', error: 'Source returned HTTP 500' },
        ],
      },
      { url: origin + '/event/2', kind: 'event', html: eventHtml(), supporting: [] },
      { url: origin + '/event/3', kind: 'event', html: eventHtml(), supporting: [] },
    ],
  };
  const failure = Object.assign(Error('timeout'), { code: 'timeout' });
  const result = await extractPages(base, crawl, {
    checkedAt,
    extractor: stubExtractor({
      [origin + '/event/1']: (context) => {
        assert.equal(context.pageKind, 'event');
        assert.deepEqual(
          context.documents.map((d) => d.url),
          [origin + '/event/1', organizer + '/shows/qa'],
        );
        return model();
      },
      // Only a date outside this and next month.
      [origin + '/event/2']: () =>
        model((e) => {
          e.schedule.dates[0].start.month = 3;
          e.schedule.dates[0].start.year = 2027;
          e.schedule.dates[0].quote = 'QA Hall';
        }),
      [origin + '/event/3']: failure,
    }),
  });
  const [first, second, third] = result.pages;
  assert.equal(first.outcome, 'events');
  assert.deepEqual(
    first.supporting.map((s) => [s.url, s.used]),
    [
      [organizer + '/shows/qa', true],
      [organizer + '/shows/empty', false],
      [organizer + '/shows/down', false],
    ],
  );
  assert.equal(first.events[0].title, 'QA Concert');
  assert.equal(first.events[0].url, origin + '/event/1');
  assert.deepEqual(
    first.events[0].sessions.map((s) => s.startAt),
    ['2026-11-21T01:00:00.000Z'],
  );
  assert.equal(second.outcome, 'outside-window');
  assert.equal(second.outsideWindow, 1);
  assert.deepEqual([third.outcome, third.reason], ['failed', 'timeout']);
  assert.equal(result.counts.events, 1);
  assert.equal(result.counts.supportingUsed, 1);
  assert.equal(result.counts.estimatedCostUsd, 0.002);
});

test('a listing page yields several events, each with its own published detail link', () => {
  const context = prepareExtractionContext({
    source: 'qa-events',
    pageUrl: origin + '/events',
    pageKind: 'listing',
    checkedAt,
    pages: [
      {
        url: origin + '/events',
        html: `<main><h2>QA Concert</h2><p>November 20, 2026 at 7 PM</p><p>QA Hall</p>
          <a href="/event/1">More</a><h2>QA Recital</h2><p>December 4, 2026 at 7 PM</p></main>`,
      },
    ],
  });
  const value = model((e, v) => {
    e.url = origin + '/event/1';
    const recital = structuredClone(e);
    recital.title = recital.titleQuote = 'QA Recital';
    recital.url = origin + '/event/invented';
    recital.schedule.dates[0].start = { year: 2026, month: 12, day: 4 };
    recital.schedule.dates[0].quote = 'December 4, 2026 at 7 PM';
    v.events.push(recital);
  });
  const parsed = parseEventExtraction(value, context);
  assert.deepEqual(
    parsed.events.map((e) => [e.title, e.sourceUrl, e.eventUrl]),
    [
      ['QA Concert', origin + '/events', origin + '/event/1'],
      ['QA Recital', origin + '/events', null],
    ],
  );
  assert.ok(parsed.issues.includes('/events/1/url: URL not in supplied source material'));
});

test('redirects are followed only within approved origins', async () => {
  const pages = {
    [origin + '/events']: '<a href="/event/1">A</a><a href="/event/2">B</a>',
    [origin + '/event/1']: { redirect: origin + '/event/1/qa-concert' },
    [origin + '/event/1/qa-concert']: eventHtml(),
    [origin + '/event/2']: { redirect: 'https://elsewhere.example.test/event/2' },
  };
  const requested = [];
  const fetchImpl = async (url, init) => {
    requested.push(String(url));
    assert.equal(init.redirect, 'manual');
    const page = pages[String(url)];
    if (page?.redirect)
      return new Response(null, { status: 301, headers: { location: page.redirect } });
    return page === undefined ? new Response('', { status: 404 }) : new Response(page);
  };
  const crawl = await crawlSource(base, { fetchImpl, pauseMs: 0 });
  assert.deepEqual(
    crawl.pages.map((p) => p.url),
    [origin + '/event/1'],
  );
  assert.match(crawl.failedPages[0].error, /outside the source scope/);
  assert.ok(!requested.some((u) => u.includes('elsewhere')));
});

test('numbered pagination and dated start URLs read the window', async () => {
  const dated = variant((d) => {
    d.fetch.startUrls = [origin + '/events/from:{today}?start={fromUnix}&end={toUnix}'];
    d.fetch.pageLinkPattern = '^/events/from:[\\d-]+/page:\\d+$';
    delete d.fetch.nextLinkPattern;
    delete d.supportingPages;
  });
  const start = origin + '/events/from:2026-11-21?start=1793509200&end=1798783200';
  // Winnipeg midnight on Nov 1 (CDT) and on Jan 1 (CST).
  const { requested, fetchImpl } = site({
    [start]: `<a href="/events/from:2026-11-21/page:2">2</a><a href="/events/from:2026-11-21/page:3">3</a>`,
    [origin + '/events/from:2026-11-21/page:2']: `<a href="/events/from:2026-11-21/page:3">3</a>`,
    [origin + '/events/from:2026-11-21/page:3']: '<a href="/event/7">G</a>',
  });
  const fetched = [];
  const crawl = await crawlSource(dated, {
    fetchImpl: async (url, init) => {
      fetched.push(String(url));
      return fetchImpl(url, init);
    },
    pauseMs: 0,
    checkedAt: '2026-11-21T18:00:00Z',
  });
  assert.equal(fetched[0], start);
  assert.equal(crawl.listPagesRead, 3);
  assert.equal(requested.filter((u) => u.includes('page:3')).length, 1);
  assert.equal(crawl.discovered, 1);
});

test('city filter: named city or postal area is in, another town is out, otherwise unknown', () => {
  const city = { name: 'Winnipeg', postalPrefixes: ['R2', 'R3'] };
  const place = (address, venue = 'Hall', quote = '') => ({
    address,
    venue,
    evidence: quote ? [{ fields: ['/venue'], quote }] : [],
  });
  assert.equal(cityMatch(city, place('555 Main St, Winnipeg, Manitoba R3B 1C3')), 'in');
  assert.equal(cityMatch(city, place('525 Wardlaw Ave.', 'Hall', 'Hall, Winnipeg R3L 0L9')), 'in');
  assert.equal(cityMatch(city, place('10 Centre St, Gimli, Manitoba R0C 1B1')), 'out');
  assert.equal(cityMatch(city, place('5353 Portage Avenue, Headingley, Manitoba')), 'out');
  assert.equal(cityMatch(city, place('1175 18th St', 'Curling Club')), 'unknown');
  assert.equal(cityMatch(city, { ...place('1175 18th St'), locality: 'Brandon' }), 'out');
  assert.equal(cityMatch(city, { ...place('611 Main Street'), locality: 'Winnipeg' }), 'in');
  assert.throws(() => validateSource(variant((d) => (d.city = { name: 'Winnipeg' }))));
  assert.ok(validateSource(variant((d) => (d.city = city))));
});

test('listing entries that link each date of one event share its key', () => {
  const config = validateSource(base);
  const entry = (date) =>
    eventKey(config, {
      url: `${origin}/event/42/${date}`,
      pageUrl: origin + '/events',
      kind: 'listing',
      title: 'QA',
      venue: 'Hall',
    });
  assert.equal(entry('2026-11-21'), entry('2026-12-05'));
  assert.equal(entry('2026-11-21'), 'key:42');
});
