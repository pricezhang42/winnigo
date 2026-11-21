// Configurable AI sources: a settings entry instead of a per-site parser. One shared crawler
// reads list pages, follows event links and pagination within an allowed origin, and the shared
// extraction pipeline reads each event page. Results are saved for review only; nothing is
// published as a listing.
import { load } from 'cheerio';
import { eventListingId, sources as publicSources } from '../connectors.mjs';
import { sourceReader } from './public-event-collector.mjs';
import { createExtractionShadow } from './extraction-rollout.mjs';

const LIMITS = { listPages: 20, eventPages: 100 };
const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * Reviewed source definitions. Adding a site means adding an entry here (code review covers
 * its fetch scope). `reference` names an existing parser source to compare candidates with.
 */
export const AI_SOURCES = [
  {
    id: 'tourism-winnipeg-ai',
    name: 'Tourism Winnipeg (AI source test)',
    allowedOrigin: 'https://www.tourismwinnipeg.com',
    startUrls: ['https://www.tourismwinnipeg.com/festivals-and-events/upcoming-events'],
    eventLinkPattern: '^/festivals-and-events/upcoming-events/display,event/\\d+(?:/[^/]+)?/?$',
    listLinkPattern: '^/festivals-and-events/upcoming-events(?:/page:\\d+)?/?$',
    maxListPages: 4,
    maxEventPages: 36,
    selector: '#content',
    reference: 'tourism-winnipeg',
  },
];

/** Validate a definition; returns it with compiled patterns. Throws on anything unsafe. */
export function validateAiSource(definition) {
  const d = definition || {};
  if (!ID.test(d.id || '')) throw Error('AI source id must be a lowercase slug');
  if (publicSources.some((source) => source.id === d.id))
    throw Error(`AI source id ${d.id} collides with an existing source`);
  if (typeof d.name !== 'string' || !d.name.trim()) throw Error(`AI source ${d.id} needs a name`);
  let origin;
  try {
    origin = new URL(d.allowedOrigin);
  } catch {
    throw Error(`AI source ${d.id} needs an https allowedOrigin`);
  }
  if (origin.protocol !== 'https:' || origin.origin !== d.allowedOrigin)
    throw Error(`AI source ${d.id} allowedOrigin must be a bare https origin`);
  const pattern = (value, name, required) => {
    if (value === undefined && !required) return null;
    if (typeof value !== 'string' || !value.startsWith('^'))
      throw Error(`AI source ${d.id} ${name} must be an anchored pattern`);
    return new RegExp(value);
  };
  const limit = (value, name, max) => {
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw Error(`AI source ${d.id} ${name} must be an integer from 1 to ${max}`);
    return value;
  };
  if (!Array.isArray(d.startUrls) || !d.startUrls.length || d.startUrls.length > 5)
    throw Error(`AI source ${d.id} needs one to five startUrls`);
  const config = {
    ...d,
    eventPattern: pattern(d.eventLinkPattern, 'eventLinkPattern', true),
    listPattern: pattern(d.listLinkPattern, 'listLinkPattern', false),
    maxListPages: limit(d.maxListPages, 'maxListPages', LIMITS.listPages),
    maxEventPages: limit(d.maxEventPages, 'maxEventPages', LIMITS.eventPages),
  };
  config.startUrls = d.startUrls.map((url) => aiSourceUrl(config, url));
  if (d.reference !== undefined && !publicSources.some((source) => source.id === d.reference))
    throw Error(`AI source ${d.id} reference ${d.reference} is not a known source`);
  return config;
}

/** An https URL on the allowed origin, without credentials or fragment. */
export function aiSourceUrl(config, value, base = config.allowedOrigin) {
  const url = new URL(value, base);
  if (
    url.protocol !== 'https:' ||
    url.origin !== config.allowedOrigin ||
    url.username ||
    url.password
  )
    throw Error('Refused URL outside the AI source origin');
  url.hash = '';
  return url.href;
}

const path = (href) => {
  const url = new URL(href);
  return url.pathname + url.search;
};
const NEXT_TEXT = /^(?:next(?: page)?|older(?: posts| events)?|›|>)$/i;

/** The page's "next page" link: rel=next, a `next` class, or a Next / › label. */
function nextLink($, config, pageUrl) {
  const candidates = $('a[href]')
    .toArray()
    .filter((node) => {
      const a = $(node);
      const rel = (a.attr('rel') || '').toLowerCase().split(/\s+/);
      const classes = (a.attr('class') || '').toLowerCase().split(/\s+/);
      return rel.includes('next') || classes.includes('next') || NEXT_TEXT.test(a.text().trim());
    });
  for (const node of candidates) {
    try {
      const href = aiSourceUrl(config, $(node).attr('href'), pageUrl);
      if (!config.listPattern || config.listPattern.test(path(href))) return href;
    } catch {
      // A next link off the allowed origin is ignored.
    }
  }
  return null;
}

/**
 * Read list pages and the event pages they link to, within the definition's limits. Returns
 * the fetched event pages; it never interprets their content.
 */
export async function crawlAiSource(
  definition,
  { fetchImpl = fetch, pauseMs = 1000, maxRunMs = 600_000 } = {},
) {
  const config = validateAiSource(definition);
  const read = sourceReader({
    validateUrl: (value) => aiSourceUrl(config, value),
    fetchImpl,
    pauseMs,
    maxRunMs,
    maxRequests: config.maxListPages + config.maxEventPages,
  });
  const result = { listPagesRead: 0, discovered: 0, eventPages: [], failedPages: [] };
  const queue = [...config.startUrls];
  const seenLists = new Set();
  const eventUrls = [];
  while (queue.length && result.listPagesRead < config.maxListPages) {
    const url = queue.shift();
    if (seenLists.has(url)) continue;
    seenLists.add(url);
    let html;
    try {
      html = (await read(url)).toString('utf8');
    } catch (error) {
      if (!result.listPagesRead && !queue.length) throw error;
      result.failedPages.push({ url, error: error.message });
      continue;
    }
    result.listPagesRead++;
    const $ = load(html);
    for (const node of $('a[href]').toArray()) {
      let href;
      try {
        href = aiSourceUrl(config, $(node).attr('href'), url);
      } catch {
        continue;
      }
      if (config.eventPattern.test(path(href)) && !eventUrls.includes(href)) eventUrls.push(href);
    }
    const next = nextLink($, config, url);
    if (next && !seenLists.has(next)) queue.push(next);
  }
  result.discovered = eventUrls.length;
  for (const url of eventUrls.slice(0, config.maxEventPages)) {
    try {
      result.eventPages.push({ url, html: (await read(url)).toString('utf8') });
    } catch (error) {
      result.failedPages.push({ url, error: error.message });
    }
  }
  if (eventUrls.length > config.maxEventPages)
    result.failedPages.push({
      url: config.startUrls[0],
      error: `Event page limit reached (${config.maxEventPages} of ${eventUrls.length})`,
    });
  return result;
}

const comparable = (url) => {
  const u = new URL(url);
  return (u.origin.toLowerCase() + u.pathname.replace(/\/+$/, '')).toLowerCase();
};

/** Index reference listings by their source and event URLs. */
export function referenceIndex(listings) {
  const index = new Map();
  for (const item of listings)
    for (const url of [item.url, item.eventUrl])
      if (url)
        try {
          index.set(comparable(url), item);
        } catch {
          // Listings without a usable URL cannot be matched.
        }
  return {
    // Exact URL first, then without the last path segment: sites often add a slug to a
    // canonical event URL (`/display,event/123/title` vs `/display,event/123`).
    get: (url) => {
      try {
        const key = comparable(url);
        return index.get(key) ?? index.get(key.replace(/\/[^/]+$/, ''));
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Crawl one AI source and extract its event pages in review mode. Rows go to
 * `event_extraction_comparisons` with outcome `candidate`, or `agree` / `differ` when a
 * reference listing exists for the same URL. No listings are written.
 */
export async function runAiReview(
  definition,
  {
    pool,
    extractor,
    checkedAt = new Date().toISOString(),
    reference = [],
    maxMs = 600_000,
    ...crawlOptions
  },
) {
  const config = validateAiSource(definition);
  const crawl = await crawlAiSource(definition, crawlOptions);
  const review = createExtractionShadow({
    mode: 'review',
    pool,
    source: { id: config.id, name: config.name },
    checkedAt,
    extractor,
    maxMs,
    maxPages: config.maxEventPages,
    reference: referenceIndex(reference),
  });
  for (const page of crawl.eventPages)
    review.capture({
      url: page.url,
      html: page.html,
      selector: config.selector,
      exclude: config.exclude,
      id: eventListingId(config.id, page.url),
      itemIds: [],
    });
  const { counts, note } = await review.finish({ runId: null, items: [] });
  return {
    source: config.id,
    listPagesRead: crawl.listPagesRead,
    discovered: crawl.discovered,
    eventPagesRead: crawl.eventPages.length,
    failedPages: crawl.failedPages,
    counts,
    note,
  };
}
