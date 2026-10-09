// Event descriptions: list-page summaries (The Forks, Assiniboine Park) and event pages
// (Travel Manitoba), checked against the saved pages in scripts/fixtures/pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DESCRIPTION_LIMIT,
  MAX_EVENT_PAGES,
  collectSourcePages,
  isPlaceholderDescription,
  parseEventPageDescription,
  parseSource,
  placeholderDescription,
  sources,
  summarize,
} from '../../lib/connectors.mjs';

const CHECKED_AT = '2026-10-08T12:00:00Z';
const page = (name) =>
  readFileSync(new URL(`../fixtures/pages/${name}.html`, import.meta.url), 'utf8');
const source = (id) => sources.find((candidate) => candidate.id === id);

test('summaries are plain text, bounded and cut at a sentence', () => {
  assert.equal(summarize('<p>Fun for all &amp; free.</p>'), 'Fun for all & free.');
  assert.equal(summarize('It&#x27;s on.'), "It's on.");
  const sentences = 'A sentence that keeps going. '.repeat(40);
  const cut = summarize(sentences);
  assert.ok(cut.length <= DESCRIPTION_LIMIT);
  assert.match(cut, /going\.$/);
  const words = 'word '.repeat(200);
  assert.match(summarize(words), /word…$/);
  assert.ok(summarize(words).length <= DESCRIPTION_LIMIT + 1);
  assert.equal(isPlaceholderDescription(placeholderDescription('The Forks')), true);
  assert.equal(isPlaceholderDescription('See you there for the full program.'), false);
});

test('The Forks and Assiniboine Park read the summary from their list pages', () => {
  for (const [id, name] of [
    ['forks', 'forks-2026-10'],
    ['forks', 'forks-2026-11'],
    ['forks', 'forks-2026-12'],
    ['park', 'park-page-1'],
    ['park', 'park-page-2'],
    ['park', 'park-page-3'],
  ])
    for (const item of parseSource(id, page(name), CHECKED_AT)) {
      assert.equal(isPlaceholderDescription(item.description), false, `${name}: ${item.title}`);
      assert.ok(item.description.length <= DESCRIPTION_LIMIT);
      assert.doesNotMatch(item.description, /<|Location:|Categories:/);
    }
  const [forks] = parseSource('forks', page('forks-2026-10'), CHECKED_AT);
  assert.match(forks.description, /^Experience Indigenous fashion rooted in culture/);
  const [park] = parseSource('park', page('park-page-1'), CHECKED_AT);
  assert.match(park.description, /^Boo at the Zoo is a Halloween tradition for the whole family!/);
});

test('Travel Manitoba event pages give a description; list cards keep the placeholder', () => {
  for (const item of parseSource('manitoba', page('manitoba-page-1'), CHECKED_AT))
    assert.equal(isPlaceholderDescription(item.description), true);
  const description = parseEventPageDescription(page('manitoba-event'));
  assert.match(description, /^The Show Where Stand-Up Comedians/);
  assert.match(description, /…$/); // the site's own meta description is cut mid-sentence
  assert.equal(parseEventPageDescription('<html></html>'), '');
  assert.equal(
    parseEventPageDescription(
      '<script type="application/ld+json">{"@type":"Event","description":"Short &amp; sweet."}</script>',
    ),
    'Short & sweet.',
  );
});

test('event pages are read only for new events, within the limit and on the source site', async () => {
  const listUrl = 'https://www.travelmanitoba.com/events/';
  const items = parseSource('manitoba', page('manitoba-page-1'), CHECKED_AT);
  const [known, failing, ...rest] = items;
  const requested = [];
  const fetchPage = async (url) => {
    requested.push(url);
    if (url === listUrl) return page('manitoba-page-1').replace(/[?&;]page=\d+/g, '');
    if (url === failing.url) throw Error('Source returned HTTP 503');
    return page('manitoba-event');
  };
  const result = await collectSourcePages(source('manitoba'), CHECKED_AT, {
    fetchPage,
    pauseMs: 0,
    knownDescriptions: new Map([[known.url, 'Stored description.']]),
  });
  const byUrl = new Map(result.items.map((item) => [item.url, item]));
  assert.equal(byUrl.get(known.url).description, 'Stored description.');
  assert.equal(requested.includes(known.url), false); // reused, not fetched again
  assert.equal(isPlaceholderDescription(byUrl.get(failing.url).description), true);
  assert.equal(result.eventPageFailures, 1);
  assert.equal(result.eventPagesRead, rest.length);
  for (const item of rest) assert.match(byUrl.get(item.url).description, /^The Show Where/);
  assert.deepEqual(result.failedPages, []); // event-page failures never make a run partial
  assert.ok(MAX_EVENT_PAGES >= items.length);
});

test('at most MAX_EVENT_PAGES event pages are read per run', async () => {
  const cards = Array.from(
    { length: MAX_EVENT_PAGES + 5 },
    (_, n) =>
      `<article class="card js-dir-item"><h3><a href="/events/e${n}/">Event ${n}</a></h3>` +
      `<div class="card__subtitle">Oct 20</div><p class="card__summary">1 Main St, Winnipeg, Manitoba</p></article>`,
  ).join('');
  let eventRequests = 0;
  const result = await collectSourcePages(source('manitoba'), CHECKED_AT, {
    pauseMs: 0,
    fetchPage: async (url) => {
      if (url === source('manitoba').url) return cards;
      eventRequests++;
      return page('manitoba-event');
    },
  });
  assert.equal(result.items.length, MAX_EVENT_PAGES + 5);
  assert.equal(eventRequests, MAX_EVENT_PAGES);
  assert.equal(result.items.filter((item) => isPlaceholderDescription(item.description)).length, 5);
});
