// Source-list collection (docs/30). Code fetches every page within each source's declared
// scope; the model only reads prepared text. This module validates definitions, fetches pages
// and extracts events in memory. Storing and publishing them is step 2 of the redesign.
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { EVENT_SOURCES } from '../../config/sources.mjs';
import { categoryFor, localDay, summarize } from '../connectors.mjs';
import { extractionDateResolver, parseEventExtraction } from '../contracts/event-extraction.mjs';
import { prepareExtractionContext, prepareExtractionDocument } from './event-page-preparation.mjs';
import { mapExtractedSchedule } from './extracted-event-schedule.mjs';
import { sourceReader } from './source-reader.mjs';
import { collectionWindow, zonedTimestamp } from '../event-schedule.mjs';

const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const STATUSES = ['active', 'paused', 'blocked'];
const METHODS = ['pages', 'single-page', 'browser'];
const LIMITS = { listPages: 20, eventPages: 200, supporting: 3, startUrls: 5, sites: 30 };
// Five cron fields; validated loosely here, pg-boss parses them when schedules are registered.
const CRON = /^(?:[\d*,/-]+\s+){4}[\d*,/-]+$/;

/** A bare https origin (`https://host[:port]`), or throws. */
function httpsOrigin(value, where) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error(`${where} must be an https origin`);
  }
  if (url.protocol !== 'https:' || url.origin !== value)
    throw Error(`${where} must be a bare https origin`);
  return value;
}

/** Validate one definition; returns it with compiled patterns. Throws on anything unsafe. */
export function validateSource(definition) {
  const d = definition || {};
  const where = `Source ${d.id || '(no id)'}`;
  if (!ID.test(d.id || '')) throw Error(`${where}: id must be a lowercase slug`);
  if (typeof d.name !== 'string' || !d.name.trim()) throw Error(`${where}: name is required`);
  if (!STATUSES.includes(d.status)) throw Error(`${where}: status must be ${STATUSES.join(', ')}`);
  if (d.schedule !== 'manual' && !CRON.test(d.schedule || ''))
    throw Error(`${where}: schedule must be 'manual' or a cron expression`);
  const f = d.fetch || {};
  if (!METHODS.includes(f.method)) throw Error(`${where}: fetch.method must be ${METHODS}`);
  const origin = httpsOrigin(f.allowedOrigin, `${where} fetch.allowedOrigin`);
  const pattern = (value, name, required = false) => {
    if (value === undefined && !required) return null;
    if (typeof value !== 'string' || !value.startsWith('^'))
      throw Error(`${where}: ${name} must be an anchored pattern`);
    return new RegExp(value);
  };
  const limit = (value, name, max) => {
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw Error(`${where}: ${name} must be an integer from 1 to ${max}`);
    return value;
  };
  const pages = f.method !== 'single-page';
  const config = {
    ...d,
    origins: new Set([origin]),
    eventPattern: pattern(f.eventLinkPattern, 'fetch.eventLinkPattern', pages),
    keyPattern: pattern(f.eventKeyPattern, 'fetch.eventKeyPattern'),
    nextPattern: pattern(f.nextLinkPattern, 'fetch.nextLinkPattern'),
    pagePattern: pattern(f.pageLinkPattern, 'fetch.pageLinkPattern'),
    maxListPages: limit(f.maxListPages, 'fetch.maxListPages', LIMITS.listPages),
    maxEventPages: pages ? limit(f.maxEventPages, 'fetch.maxEventPages', LIMITS.eventPages) : 0,
    supporting: null,
  };
  if (config.keyPattern && !/\((?!\?)/.test(f.eventKeyPattern))
    throw Error(`${where}: fetch.eventKeyPattern needs one capture group`);
  if (!Array.isArray(f.startUrls) || !f.startUrls.length || f.startUrls.length > LIMITS.startUrls)
    throw Error(`${where}: fetch.startUrls needs one to ${LIMITS.startUrls} URLs`);
  // Validate with a sample window; crawls expand the placeholders for their own window.
  const sample = windowValues(new Date().toISOString());
  for (const url of f.startUrls) sourceUrl(config, expandWindow(url, sample));
  config.startUrls = f.startUrls;
  if (d.supportingPages) {
    if (!pages) throw Error(`${where}: supportingPages need event pages`);
    const s = d.supportingPages;
    if (!Array.isArray(s.sites) || !s.sites.length || s.sites.length > LIMITS.sites)
      throw Error(`${where}: supportingPages.sites needs one to ${LIMITS.sites} sites`);
    config.supporting = {
      maxPerPage: limit(s.maxPerPage, 'supportingPages.maxPerPage', LIMITS.supporting),
      sites: s.sites.map((site, i) => ({
        origin: httpsOrigin(site.origin, `${where} supportingPages.sites[${i}].origin`),
        pattern: pattern(site.pattern, `supportingPages.sites[${i}].pattern`, true),
        selector: site.selector,
      })),
    };
    for (const site of config.supporting.sites) config.origins.add(site.origin);
  }
  // Event images are copied from the source's own sites and any image hosts it names.
  const imageOrigins = d.images?.origins ?? [];
  if (!Array.isArray(imageOrigins) || imageOrigins.length > LIMITS.sites)
    throw Error(`${where}: images.origins must be a list of https origins`);
  config.imageOrigins = new Set([
    ...config.origins,
    ...imageOrigins.map((o, i) => httpsOrigin(o, `${where} images.origins[${i}]`)),
  ]);
  if (d.city !== undefined) {
    const c = d.city;
    if (
      typeof c?.name !== 'string' ||
      !/^[A-Za-z][A-Za-z .'-]{1,60}$/.test(c.name) ||
      !Array.isArray(c.postalPrefixes) ||
      !c.postalPrefixes.every((p) => /^[A-Z]\d$/.test(p))
    )
      throw Error(`${where}: city needs a name and postal prefixes such as R2`);
  }
  for (const key of ['maxInputTokens', 'maxOutputTokens'])
    if (d.extraction?.[key] !== undefined) limit(d.extraction[key], `extraction.${key}`, 32768);
  return config;
}

/**
 * Start URLs may name dates so calendar requests fetch only the collection window (this and
 * next Winnipeg month): {today}, {from} and {to} as YYYY-MM-DD; {fromUnix} and {toUnix} as
 * seconds (Winnipeg midnight at the start of the first day, and after the last day).
 */
function windowValues(checkedAt) {
  const { from, to } = collectionWindow(checkedAt);
  const next = new Date(Date.parse(to + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  const unix = (day) => String(Date.parse(zonedTimestamp(day, '00:00')) / 1000);
  const today = localDay(new Date(checkedAt));
  return { today, from, to, fromUnix: unix(from), toUnix: unix(next) };
}
const expandWindow = (url, values) =>
  url.replace(/\{(today|from|to|fromUnix|toUnix)\}/g, (_, key) => values[key]);

/** Follow redirects only while they stay within the source's approved origins. */
function scopedFetch(config, fetchImpl) {
  return async (url, init) => {
    let current = url;
    for (let hop = 0; hop <= 3; hop++) {
      const response = await fetchImpl(current, { ...init, redirect: 'manual' });
      const location =
        response.status >= 300 && response.status < 400 && response.headers.get('location');
      if (!location) return response;
      await response.body?.cancel();
      current = sourceUrl(config, location, current);
    }
    throw Error('Too many redirects');
  };
}

/** Validate the whole list: every entry, and unique ids. */
export function validateSources(list = EVENT_SOURCES) {
  const configs = list.map(validateSource);
  const ids = configs.map((c) => c.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw Error(`Source ${dup} is defined twice`);
  return configs;
}

export function findSource(id, list = EVENT_SOURCES) {
  const definition = list.find((s) => s.id === id);
  if (!definition) throw Error(`Unknown source ${id}`);
  return validateSource(definition);
}

/** An https URL on one of the source's origins, without credentials or fragment. */
export function sourceUrl(config, value, base = config.fetch.allowedOrigin) {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || !config.origins.has(url.origin) || url.username || url.password)
    throw Error('Refused URL outside the source scope');
  url.hash = '';
  return url.href;
}

const path = (href) => {
  const url = new URL(href);
  return url.pathname + url.search;
};
const NEXT_TEXT = /^(?:next(?: page| month)?|older(?: posts| events)?|›|>|»)$/i;

/** The page's "next page" link: rel=next, a `next` class, or a Next / › label. */
function nextLink($, config, pageUrl) {
  for (const node of $('a[href]').toArray()) {
    const a = $(node);
    const rel = (a.attr('rel') || '').toLowerCase().split(/\s+/);
    const classes = (a.attr('class') || '').toLowerCase().split(/\s+/);
    if (!rel.includes('next') && !classes.includes('next') && !NEXT_TEXT.test(a.text().trim()))
      continue;
    try {
      const href = sourceUrl(config, a.attr('href'), pageUrl);
      if (new URL(href).origin !== config.fetch.allowedOrigin) continue;
      if (!config.nextPattern || config.nextPattern.test(path(href))) return href;
    } catch {
      // A next link outside the source scope is ignored.
    }
  }
  return null;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Link targets on a list page: anchor hrefs, plus absolute URLs on the allowed origin written
 * in the raw text, so calendar feeds (iCalendar folds long lines) and embedded JSON count too.
 */
function pageLinks($, raw, allowedOrigin) {
  const links = $('a[href]')
    .toArray()
    .map((node) => $(node).attr('href'));
  const text = raw.replace(/\r?\n[ \t]/g, '').replace(/\\\//g, '/');
  const absolute = new RegExp(`${escapeRegExp(allowedOrigin)}/[^\\s"'<>\\\\]*`, 'g');
  return [...links, ...(text.match(absolute) || [])];
}

// Words of a URL path, for matching an event page to its own series page.
const GENERIC_WORDS = new Set(['event', 'events', 'series', 'show', 'the', 'and', 'for', 'www']);
const pathWords = (url) =>
  new Set(
    new URL(url).pathname
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !/^\d+$/.test(w) && !GENERIC_WORDS.has(w)),
  );

/**
 * Links on an event page to approved supporting pages (organizer or series pages). Pages often
 * also link other events' series (previous/next navigation), so candidates sharing the most
 * path words with the event page come first; ties keep their order on the page.
 */
function supportingLinks($, config, pageUrl) {
  const found = [];
  for (const node of $('a[href]').toArray()) {
    let href;
    try {
      href = sourceUrl(config, $(node).attr('href'), pageUrl);
    } catch {
      continue;
    }
    const site = config.supporting.sites.find(
      (s) => s.origin === new URL(href).origin && s.pattern.test(path(href)),
    );
    if (site && href !== pageUrl && !found.some((f) => f.url === href))
      found.push({ url: href, selector: site.selector });
  }
  const own = pathWords(pageUrl);
  const shared = (url) => [...pathWords(url)].filter((w) => own.has(w)).length;
  return found
    .map((link, order) => ({ link, order, score: shared(link.url) }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, config.supporting.maxPerPage)
    .map(({ link }) => link);
}

/**
 * Fetch a source's pages within its limits. Returns `pages` for extraction: event pages
 * (`kind: 'event'`, with any supporting pages) or list pages (`kind: 'listing'`). Content is
 * never interpreted here.
 */
export async function crawlSource(
  definition,
  {
    fetchImpl = fetch,
    pauseMs = 1000,
    maxRunMs = 600_000,
    checkedAt = new Date().toISOString(),
  } = {},
) {
  const config = validateSource(definition);
  if (config.status !== 'active') throw Error(`Source ${config.id} is ${config.status}`);
  if (config.fetch.method === 'browser')
    throw Error(`Source ${config.id}: the browser fetch method is not supported yet`);
  const supportingMax = config.supporting?.maxPerPage || 0;
  const read = sourceReader({
    validateUrl: (value) => sourceUrl(config, value),
    fetchImpl: scopedFetch(config, fetchImpl),
    pauseMs,
    maxRunMs,
    maxRequests: config.maxListPages + config.maxEventPages * (1 + supportingMax),
  });
  const text = async (url) => (await read(url)).toString('utf8');
  const listing = config.fetch.method === 'single-page';
  const result = { listPagesRead: 0, discovered: 0, pages: [], failedPages: [] };
  const window = windowValues(checkedAt);
  const startUrls = config.startUrls.map((url) => sourceUrl(config, expandWindow(url, window)));
  const queue = [...startUrls];
  const seenLists = new Set();
  const events = new Map(); // key → first URL
  while (queue.length && result.listPagesRead < config.maxListPages) {
    const url = queue.shift();
    if (seenLists.has(url)) continue;
    seenLists.add(url);
    let html;
    try {
      html = await text(url);
    } catch (error) {
      if (!result.listPagesRead && !queue.length) throw error;
      result.failedPages.push({ url, error: error.message });
      continue;
    }
    result.listPagesRead++;
    const $ = load(html);
    if (listing) result.pages.push({ url, html, kind: 'listing', supporting: [] });
    else
      for (const value of pageLinks($, html, config.fetch.allowedOrigin)) {
        let href;
        try {
          href = sourceUrl(config, value, url);
        } catch {
          continue;
        }
        const p = path(href);
        if (new URL(href).origin !== config.fetch.allowedOrigin || !config.eventPattern.test(p))
          continue;
        const key = config.keyPattern?.exec(p)?.[1] ?? href;
        if (!events.has(key)) events.set(key, href);
      }
    const next = nextLink($, config, url);
    if (next && !seenLists.has(next)) queue.push(next);
    // Numbered pagination: every matching list link, in page order.
    if (config.pagePattern)
      for (const node of $('a[href]').toArray())
        try {
          const href = sourceUrl(config, $(node).attr('href'), url);
          if (
            new URL(href).origin === config.fetch.allowedOrigin &&
            config.pagePattern.test(path(href)) &&
            !seenLists.has(href) &&
            !queue.includes(href)
          )
            queue.push(href);
        } catch {
          // Links outside the source scope are ignored.
        }
  }
  result.discovered = listing ? result.pages.length : events.size;
  for (const url of [...events.values()].slice(0, config.maxEventPages)) {
    let html;
    try {
      html = await text(url);
    } catch (error) {
      result.failedPages.push({ url, error: error.message });
      continue;
    }
    const page = { url, html, kind: 'event', supporting: [] };
    if (config.supporting)
      for (const link of supportingLinks(load(html), config, url))
        try {
          page.supporting.push({ ...link, html: await text(link.url) });
        } catch (error) {
          page.supporting.push({ ...link, error: error.message });
        }
    result.pages.push(page);
  }
  if (events.size > config.maxEventPages)
    result.failedPages.push({
      url: startUrls[0],
      error: `Event page limit reached (${config.maxEventPages} of ${events.size})`,
    });
  return result;
}

/**
 * The event's identity within its source: the event key pattern's match, the event's own URL
 * (without query or trailing slash), or for a listing entry without a link, the listing page
 * plus title and venue.
 */
export function eventKey(config, { url, pageUrl, kind, title, venue }) {
  const u = new URL(url);
  const match =
    u.origin === config.fetch.allowedOrigin && config.keyPattern?.exec(u.pathname + u.search);
  if (match) return 'key:' + match[1];
  const base = (u.origin + u.pathname).replace(/\/+$/, '').toLowerCase();
  if (kind === 'event' || url !== pageUrl) return 'url:' + base;
  const slug = (value) =>
    String(value || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  return `entry:${base}#${slug(title)}@${slug(venue)}`;
}

/** Summarize one extracted event: facts plus sessions inside the collection window. */
function summarizeEvent(event, context, config) {
  const url = event.eventUrl || event.sourceUrl;
  const page = context.documents.find((d) => d.url === context.pageUrl);
  const summary = {
    url,
    title: event.title,
    category: categoryFor(event.title || ''),
    // The model does not write descriptions; an event's own page is summarized instead.
    description:
      context.pageKind === 'event'
        ? summarize((page?.text || '').replace(/^\s*---+\s*$/gm, '').replace(/^#{1,6}\s+/gm, ''))
        : '',
    venue: event.venue?.name || (event.venue?.mode === 'online' ? 'Online' : null),
    address: event.venue?.address ?? null,
    venueFallback:
      !event.venue?.name && event.venue?.mode !== 'online' && config.defaultVenue?.name
        ? config.defaultVenue
        : null,
    price: event.price,
    availability: event.availability ?? null,
    organizerUrl: event.organizerUrl,
    ticketUrl: event.ticketUrl,
    images: event.images.map((i) => i.url),
    status: event.status,
    reviewReasons: event.reviewReasons,
    sessions: [],
    runDates: null,
    scheduleError: null,
    evidence: event.evidence,
  };
  try {
    const schedule = mapExtractedSchedule(
      event,
      { id: `${config.id}:${url}`, url },
      context,
      extractionDateResolver(context),
    );
    summary.sessions = schedule.occurrences.map((o) => ({
      start: o.start,
      end: o.end,
      startAt: o.startAt ?? null,
      endAt: o.endAt ?? null,
      status: o.status,
    }));
    summary.runDates = Object.keys(schedule.runDates).length ? schedule.runDates : null;
  } catch (error) {
    summary.scheduleError = error.message || 'unresolved-schedule';
  }
  summary.key = eventKey(config, {
    url,
    pageUrl: context.pageUrl,
    kind: context.pageKind,
    title: summary.title,
    venue: summary.venue,
  });
  return summary;
}

const POSTAL = /\b([A-Z]\d)[A-Z] ?\d[A-Z]\d\b/i;
/**
 * Whether an event is in the source's city: `in` when its address or venue names the city or
 * one of its postal prefixes, `out` when it names another postal area or `<Town>, <Province>`,
 * otherwise `unknown`.
 */
export function cityMatch(city, event) {
  const venueQuotes = (event.evidence || [])
    .filter((e) => e.fields?.some((f) => f.startsWith('/venue')))
    .map((e) => e.quote);
  const text = [event.address, event.modelAddress, event.venue, ...venueQuotes]
    .filter(Boolean)
    .join('\n');
  const name = city.name.toLowerCase();
  if (text.toLowerCase().includes(name)) return 'in';
  // The page's structured address (schema.org addressLocality) names the town outright.
  if (event.locality) return event.locality.trim().toLowerCase() === name ? 'in' : 'out';
  const postal = text.match(POSTAL)?.[1]?.toUpperCase();
  if (postal) return city.postalPrefixes.includes(postal) ? 'in' : 'out';
  if (/,\s*[A-Z][A-Za-z.' -]+,\s*(?:Manitoba|MB|Ontario|ON|Saskatchewan|SK)\b/.test(text))
    return 'out';
  return 'unknown';
}

/** Hash of what the model would read and how: a match means the stored output still applies. */
export function contentHash(context, extractor) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        context.pageKind,
        context.documents,
        extractor?.model ?? null,
        extractor?.extractionVersion ?? null,
      ]),
    )
    .digest('hex');
}

/**
 * Extract every crawled page. Each page's result carries its events with sessions in this and
 * next Winnipeg month, the identities of events dated only outside it, the model output, the
 * content hash and the cost. `reuse(url, hash)` may return a stored model output for a page
 * whose content is unchanged; it is validated again against the current page.
 */
export async function extractPages(
  definition,
  crawl,
  { extractor, checkedAt, maxMs = 600_000, reuse = async () => null },
) {
  const config = validateSource(definition);
  const signal = AbortSignal.timeout(maxMs);
  const pages = [];
  let stopped = null;
  for (const page of crawl.pages) {
    const row = { url: page.url, kind: page.kind, supporting: [], events: [], issues: [] };
    pages.push(row);
    if (stopped || signal.aborted) {
      Object.assign(row, { outcome: 'skipped', reason: stopped || 'time-limit' });
      continue;
    }
    // A supporting page that cannot be prepared is left out; the event page still counts.
    const supporting = [];
    for (const s of page.supporting) {
      const used = { url: s.url, used: false, error: s.error ?? null };
      if (!s.error)
        try {
          prepareExtractionDocument({ url: s.url, html: s.html, selector: s.selector });
          supporting.push({ url: s.url, html: s.html, selector: s.selector });
          used.used = true;
        } catch (error) {
          used.error = error.message;
        }
      row.supporting.push(used);
    }
    let context;
    try {
      context = prepareExtractionContext({
        source: config.id,
        pageUrl: page.url,
        checkedAt,
        pageKind: page.kind,
        pages: [
          {
            url: page.url,
            html: page.html,
            selector: config.fetch.selector,
            exclude: config.fetch.exclude,
          },
          ...supporting,
        ],
      });
    } catch (error) {
      Object.assign(row, { outcome: 'failed', reason: 'preparation: ' + error.message });
      continue;
    }
    row.hash = contentHash(context, extractor);
    let parsed = null;
    const stored = await reuse(page.url, row.hash);
    if (stored)
      try {
        parsed = parseEventExtraction(stored, context);
        Object.assign(row, { raw: stored, cost: 0, reused: true });
      } catch {
        parsed = null; // stored output no longer fits the contract: extract again
      }
    if (!parsed) {
      let extraction;
      try {
        extraction = await extractor.extract(context, { signal });
      } catch (error) {
        const code = error?.code || 'extraction-failed';
        if (code === 'budget_exceeded') stopped = 'budget';
        row.cost = error?.metrics?.estimatedCostUsd ?? null;
        Object.assign(row, { outcome: 'failed', reason: code });
        continue;
      }
      row.cost = extraction.cacheHit ? 0 : (extraction.estimatedCostUsd ?? null);
      row.raw = extraction.result;
      parsed = parseEventExtraction(extraction.result, context);
    }
    row.issues = parsed.issues;
    let events = parsed.events.map((e) => summarizeEvent(e, context, config));
    // Province-wide sources keep only their city's events. Unknown places stay, flagged for
    // review; events elsewhere count as seen, so they are never reported as gone.
    const elsewhere = [];
    if (config.city)
      events = events.filter((e, i) => {
        // The address as the model read it, even when its exact text could not be quoted: it
        // only decides the city here and is never published.
        e.modelAddress = (row.raw?.events || [])[i]?.venue?.address ?? null;
        // One event's own page: its structured address names the town.
        if (page.kind === 'event')
          e.locality =
            context.documents[0].text.match(/"addressLocality"\s*:\s*"([^"]{1,80})"/)?.[1] ?? null;
        const where = cityMatch(config.city, e);
        if (where === 'out') elsewhere.push(e.key);
        if (where === 'unknown')
          e.reviewReasons = [
            ...e.reviewReasons,
            {
              field: '/venue',
              reason: `The page does not say whether this is in ${config.city.name}.`,
            },
          ];
        return where !== 'out';
      });
    row.outsideCity = elsewhere.length;
    // Events dated only outside the window are not kept, but their identity is: they have not
    // disappeared from the source.
    row.events = events.filter(
      (e) => e.sessions.length || e.scheduleError || e.reviewReasons.length,
    );
    row.outsideKeys = [
      ...events.filter((e) => !row.events.includes(e)).map((e) => e.key),
      ...elsewhere,
    ];
    row.outsideWindow = row.outsideKeys.length;
    row.outcome = row.events.length ? 'events' : events.length ? 'outside-window' : 'none';
  }
  const count = (outcome) => pages.filter((p) => p.outcome === outcome).length;
  return {
    source: config.id,
    checkedAt,
    counts: {
      pages: pages.length,
      withEvents: count('events'),
      events: pages.reduce((n, p) => n + p.events.length, 0),
      outsideWindow: count('outside-window'),
      none: count('none'),
      failed: count('failed'),
      skipped: count('skipped'),
      supportingUsed: pages.reduce((n, p) => n + p.supporting.filter((s) => s.used).length, 0),
      reused: pages.filter((p) => p.reused).length,
      outsideCity: pages.reduce((n, p) => n + (p.outsideCity || 0), 0),
      estimatedCostUsd:
        Math.round(pages.reduce((n, p) => n + (p.cost || 0), 0) * 1_000_000) / 1_000_000,
    },
    pages,
  };
}
