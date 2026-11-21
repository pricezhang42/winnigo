import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_SOURCES,
  aiSourceUrl,
  crawlAiSource,
  referenceIndex,
  runAiReview,
  validateAiSource,
} from '../../lib/server/ai-sources.mjs';
import { single } from '../fixtures/event-extraction.mjs';

const origin = 'https://events.example.test';
const definition = {
  id: 'qa-ai-source',
  name: 'QA AI source',
  allowedOrigin: origin,
  startUrls: [origin + '/events/'],
  eventLinkPattern: '^/events/[a-z0-9-]+/?$',
  listLinkPattern: '^/events/(?:page/\\d+/)?$',
  maxListPages: 2,
  maxEventPages: 5,
};
const event = (title = 'QA Concert') =>
  `<html><body><nav>Menu</nav><main><h1>${title}</h1><p>${title}. November 20, 2026 at 7 PM. QA Hall.</p></main></body></html>`;
const pages = {
  '/events/':
    '<a href="/events/concert/">Concert</a><a href="/events/talk">Talk</a>' +
    '<a href="https://elsewhere.example.test/events/x/">Off site</a><a href="/about/">About</a>' +
    '<a href="/events/page/2/" class="pager next">&gt;</a>',
  '/events/page/2/':
    '<a href="/events/concert/">Again</a><a href="/events/workshop/">Workshop</a>' +
    '<a href="/events/later/">Later</a>' +
    '<a href="/events/page/3/" rel="next">Next</a>',
  '/events/page/3/': '<a href="/events/never/">Beyond the list limit</a>',
  '/events/concert/': event(),
  '/events/talk': event(),
  '/events/workshop/': '<html><body></body></html>',
  '/events/later/':
    '<main><h1>QA Concert</h1><p>QA Concert. January 20, 2027 at 7 PM. QA Hall.</p></main>',
};
const transport =
  (log = []) =>
  async (url) => {
    const { origin: o, pathname } = new URL(url);
    log.push(url);
    if (o !== origin || !(pathname in pages)) return new Response('missing', { status: 404 });
    return new Response(pages[pathname]);
  };

test('definitions validate, and unsafe settings are refused', () => {
  for (const source of AI_SOURCES) assert.ok(validateAiSource(source).eventPattern);
  assert.ok(validateAiSource(definition));
  for (const [change, message] of [
    [{ id: 'tourism-winnipeg' }, /collides/],
    [{ allowedOrigin: 'http://events.example.test' }, /bare https origin/],
    [{ allowedOrigin: origin + '/path' }, /bare https origin/],
    [{ eventLinkPattern: '/events/' }, /anchored/],
    [{ maxEventPages: 101 }, /maxEventPages/],
    [{ startUrls: ['https://elsewhere.example.test/'] }, /outside/],
    [{ reference: 'unknown-source' }, /not a known source/],
  ])
    assert.throws(() => validateAiSource({ ...definition, ...change }), message);
  const config = validateAiSource(definition);
  assert.equal(aiSourceUrl(config, '/events/a/#top'), origin + '/events/a/');
  assert.throws(() => aiSourceUrl(config, 'https://user:pass@events.example.test/'), /outside/);
});

test('the crawler follows event links and next pages within the origin and limits', async () => {
  const log = [];
  const crawl = await crawlAiSource(definition, { fetchImpl: transport(log), pauseMs: 0 });
  assert.equal(crawl.listPagesRead, 2);
  assert.equal(crawl.discovered, 4);
  assert.deepEqual(
    crawl.eventPages.map((p) => new URL(p.url).pathname),
    ['/events/concert/', '/events/talk', '/events/workshop/', '/events/later/'],
  );
  // Off-origin links, non-event paths and pages past the list limit are never fetched.
  assert.ok(log.every((url) => url.startsWith(origin)));
  assert.ok(!log.some((url) => /about|page\/3|never/.test(url)));
  const capped = await crawlAiSource(
    { ...definition, maxEventPages: 1 },
    { fetchImpl: transport(), pauseMs: 0 },
  );
  assert.equal(capped.eventPages.length, 1);
  assert.match(capped.failedPages.at(-1).error, /Event page limit reached \(1 of 4\)/);
});

test('review mode saves candidates, compares with a reference and never writes listings', async () => {
  const inserts = [];
  const pool = {
    query: async (sql, params) => {
      assert.match(sql, /^\s*INSERT INTO event_extraction_comparisons/);
      inserts.push(params);
      return { rows: [] };
    },
  };
  // The later page is outside the November-December collection window.
  const later = structuredClone(single);
  later.event.schedule.dates[0].start = { year: 2027, month: 1, day: 20 };
  later.event.schedule.dates[0].quote = 'January 20, 2027 at 7 PM';
  const extractor = {
    extract: async (context) => ({
      result: context.pageUrl.endsWith('/later/') ? later : single,
      cacheHit: false,
      estimatedCostUsd: 0.001,
    }),
  };
  const reference = [
    {
      id: 'reference-concert',
      url: origin + '/events/concert',
      title: 'QA Concert',
      venue: 'QA Hall',
      start: '2026-11-20',
      startAt: '2026-11-21T01:00:00.000Z',
    },
  ];
  const result = await runAiReview(definition, {
    pool,
    extractor,
    checkedAt: '2026-11-06T18:00:00Z',
    reference,
    fetchImpl: transport(),
    pauseMs: 0,
  });
  const rows = Object.fromEntries(inserts.map((p) => [new URL(p[2]).pathname, p]));
  // Columns: run_id, source, page_url, outcome, reason, cache_hit, cost, differences, extracted, raw.
  assert.equal(rows['/events/concert/'][3], 'agree');
  assert.equal(rows['/events/talk'][3], 'candidate');
  assert.equal(rows['/events/workshop/'][3], 'failed');
  assert.deepEqual(rows['/events/later/'].slice(3, 5), ['skipped', 'outside-collection-window']);
  assert.equal(rows['/events/talk'][0], null);
  assert.equal(rows['/events/talk'][1], 'qa-ai-source');
  assert.equal(JSON.parse(rows['/events/talk'][8]).title, 'QA Concert');
  assert.deepEqual(JSON.parse(rows['/events/talk'][9]), single);
  assert.equal(JSON.parse(rows['/events/concert/'][8]).reference, 'reference-concert');
  assert.deepEqual(
    { ...result.counts, estimatedCostUsd: undefined },
    {
      mode: 'review',
      pages: 4,
      candidate: 1,
      agree: 1,
      differ: 0,
      withheld: 0,
      failed: 1,
      skipped: 1,
      cacheHits: 0,
      estimatedCostUsd: undefined,
    },
  );
  assert.match(
    result.note,
    /^Extraction review: 1 candidate\(s\), 1\/4 page\(s\) agree, 1 failed, 1 skipped/,
  );
});

test('reference listings match exact URLs or the URL without its trailing slug', () => {
  const item = {
    id: 'ref',
    url: origin + '/display,event/11',
    eventUrl: origin + '/display,event/11',
  };
  const index = referenceIndex([item]);
  assert.equal(index.get(origin + '/display,event/11/first-friday'), item);
  assert.equal(index.get(origin + '/display,event/11/'), item);
  assert.equal(index.get(origin + '/display,event/12/first-friday'), undefined);
});
