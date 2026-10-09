import {
  freeSwimSource,
  parseFreeSwim,
  applyPoolClosures,
  poolDirectoryUrl,
} from './free-swim.mjs';
export const sources = [
  freeSwimSource,
  { id: 'forks', name: 'The Forks', url: 'https://www.theforks.com/events/calendar-of-events' },
  { id: 'park', name: 'Assiniboine Park', url: 'https://www.assiniboinepark.ca/events' },
  { id: 'attractions', name: 'The Forks · places', url: 'https://www.theforks.com/attractions' },
  { id: 'manitoba', name: 'Travel Manitoba', url: 'https://www.travelmanitoba.com/events/' },
  // Collected by the worker only (lib/server/rotary.mjs): it reads posters and QR codes.
  {
    id: 'winnipeg-rotary',
    name: 'Rotary Club of Winnipeg',
    url: 'https://winnipegrotary.org/',
    workerOnly: true,
  },
];
export const clean = (s = '') =>
  s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(
      /&(?:amp|nbsp|rsquo|lsquo|ldquo|rdquo|ndash|mdash|quot|lt|gt);/g,
      (m) =>
        ({
          '&amp;': '&',
          '&nbsp;': ' ',
          '&rsquo;': "'",
          '&lsquo;': "'",
          '&ldquo;': '“',
          '&rdquo;': '”',
          '&ndash;': '–',
          '&mdash;': '—',
          '&quot;': '"',
          '&lt;': '<',
          '&gt;': '>',
        })[m],
    )
    .replace(/\s+/g, ' ')
    .trim();
/** Short, stable, non-cryptographic hash (FNV-1a) for ID suffixes; runs in browsers too. */
function shortHash(text) {
  let hash = 0x811c9dc5;
  for (const char of text) hash = Math.imul(hash ^ char.codePointAt(0), 0x01000193) >>> 0;
  return hash.toString(36);
}

/**
 * Stable listing ID for an event page: the source plus the page's URL path, never its dates, so an
 * ongoing event keeps one ID while the dates a site shows move forward. Generic path segments
 * (`events`, `calendar-of-events`) are dropped; long paths and query strings are hashed.
 */
export function eventListingId(sourceId, url) {
  const { pathname, search } = new URL(url);
  const segments = pathname
    .split('/')
    .filter((segment) => segment && !['events', 'calendar-of-events'].includes(segment));
  let slug = segments
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > 80) slug = slug.slice(0, 70).replace(/-+$/, '') + '-' + shortHash(pathname);
  if (search) slug += '-' + shortHash(search);
  return `${sourceId}-${slug || shortHash(url)}`;
}

export const DESCRIPTION_LIMIT = 600;

/** Text shown when a source gives no description; recognised by `isPlaceholderDescription`. */
export const placeholderDescription = (sourceName) =>
  `See ${sourceName} for the full program, availability and admission details.`;
export const isPlaceholderDescription = (text = '') =>
  /^See .+ for the full program, availability and admission details\.$/.test(text);

/**
 * Plain-text summary of at most `limit` characters, cut at the last sentence end that fits (or a
 * word boundary with an ellipsis). The full text stays on the source, which every listing links to.
 */
export function summarize(html = '', limit = DESCRIPTION_LIMIT) {
  const text = clean(
    String(html).replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
  );
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentenceEnd > limit / 2) return cut.slice(0, sentenceEnd + 1);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[\s,;:–-]+$/, '') + '…';
}

/**
 * Description from a Travel Manitoba event page: the longer of its schema.org Event description
 * and its meta description (both are the site's own summary). Empty if neither is present.
 */
export function parseEventPageDescription(html) {
  const candidates = [];
  for (const [, json] of html.matchAll(
    /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const data = JSON.parse(json);
      const nodes = Array.isArray(data) ? data : data['@graph'] || [data];
      for (const node of nodes)
        if (node?.['@type'] === 'Event' && typeof node.description === 'string')
          candidates.push(node.description);
    } catch {
      // Malformed JSON-LD is ignored; the meta description may still be usable.
    }
  }
  const meta = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1];
  if (meta) candidates.push(meta);
  const best =
    candidates.map((candidate) => summarize(candidate)).sort((a, b) => b.length - a.length)[0] ||
    '';
  // Sites often cut their meta description mid-sentence; mark it as an excerpt.
  return best && !/[.!?…"”')]$/.test(best) ? best + '…' : best;
}

/** Fetches one source page with a 12-second timeout and a 2 MB size cap. */
export async function fetchSourcePage(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Winnigo/1.0 (Winnipeg discovery; source-attributed listings)' },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw Error('Source returned HTTP ' + response.status);
  const html = await response.text();
  if (html.length > 2_000_000) throw Error('Unexpected source size');
  return html;
}

/**
 * Follow-up pages read after a source's first page, bounded per source:
 * - `months`: The Forks publishes one calendar list per month; read the next `months` months.
 * - `pages`: numbered `?page=N` lists; continue only while the previous page links to page N.
 */
export const PAGINATION = {
  forks: { kind: 'months', months: 2 },
  park: { kind: 'pages', max: 5 },
  manitoba: { kind: 'pages', max: 6 },
};

/** Calendar-list URLs for the months after `checkedAt` (Winnipeg time). */
export function monthPageUrls(source, checkedAt, months) {
  const [year, month] = localDay(new Date(checkedAt)).split('-').map(Number);
  return Array.from({ length: months }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1 + index + 1, 1));
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${source.url}/list/${date.getUTCFullYear()}/${mm}`;
  });
}

/** The `?page=N` URL, or null when `html` (the previous page) does not link to page N. */
export function numberedPageUrl(source, html, pageNumber) {
  if (!new RegExp(`[?&;]page=${pageNumber}(?![0-9])`).test(html)) return null;
  const url = new URL(source.url);
  url.searchParams.set('page', String(pageNumber));
  return url.href;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Sources whose list pages carry no description: read it from each event's own page.
const DESCRIBE_FROM_EVENT_PAGES = new Set(['manitoba']);
export const MAX_EVENT_PAGES = 80;

/**
 * Collects every page of a source. The first page must succeed (its error propagates); a later
 * page that fails is recorded in `failedPages` and the listings already read are kept, so the
 * caller can save a partial run. Listings are merged by URL, first occurrence wins. Pages are
 * read one at a time with `pauseMs` between requests to keep load on the source low.
 */
export async function collectSourcePages(
  source,
  checkedAt = new Date().toISOString(),
  { fetchPage = fetchSourcePage, pauseMs = 1000, knownDescriptions = new Map() } = {},
) {
  if (source.workerOnly) throw Error(`${source.name} is collected by the worker`);
  if (source.id === freeSwimSource.id) {
    const [html, pools] = await Promise.all([fetchPage(source.url), fetchPage(poolDirectoryUrl)]);
    const items = applyPoolClosures(parseFreeSwim(html, checkedAt), pools);
    return { items, pagesRead: 2, failedPages: [] };
  }
  const byUrl = new Map();
  const add = (html) => {
    for (const item of parseSource(source.id, html, checkedAt))
      if (!byUrl.has(item.url)) byUrl.set(item.url, item);
  };
  let html = await fetchPage(source.url);
  add(html);
  let pagesRead = 1;
  const failedPages = [];
  const paging = PAGINATION[source.id];
  if (paging?.kind === 'months')
    for (const url of monthPageUrls(source, checkedAt, paging.months)) {
      await pause(pauseMs);
      try {
        add(await fetchPage(url));
        pagesRead++;
      } catch (error) {
        failedPages.push({ url, error: error.message });
      }
    }
  if (paging?.kind === 'pages')
    for (let pageNumber = 2; pageNumber <= paging.max; pageNumber++) {
      const url = numberedPageUrl(source, html, pageNumber);
      if (!url) break;
      await pause(pauseMs);
      try {
        html = await fetchPage(url);
      } catch (error) {
        // Later pages are only discovered from this one, so stop here.
        failedPages.push({ url, error: error.message });
        break;
      }
      add(html);
      pagesRead++;
    }
  const { eventPagesRead, eventPageFailures } = DESCRIBE_FROM_EVENT_PAGES.has(source.id)
    ? await describeFromEventPages(source, byUrl.values(), {
        fetchPage,
        pauseMs,
        knownDescriptions,
      })
    : { eventPagesRead: 0, eventPageFailures: 0 };
  return { items: [...byUrl.values()], pagesRead, failedPages, eventPagesRead, eventPageFailures };
}

/**
 * Fills placeholder descriptions in place. A description already stored for the same URL is
 * reused, so only new events cost a request; at most MAX_EVENT_PAGES pages are read per run, and
 * only on the source's own site. A failed event page keeps the placeholder and does not fail the
 * run; it is tried again next time.
 */
async function describeFromEventPages(source, items, { fetchPage, pauseMs, knownDescriptions }) {
  const host = new URL(source.url).hostname;
  let eventPagesRead = 0;
  let eventPageFailures = 0;
  for (const item of items) {
    if (!isPlaceholderDescription(item.description)) continue;
    const known = knownDescriptions.get(item.url);
    if (known) {
      item.description = known;
      continue;
    }
    if (eventPagesRead + eventPageFailures >= MAX_EVENT_PAGES) continue;
    if (new URL(item.url).hostname !== host) continue;
    await pause(pauseMs);
    try {
      const description = parseEventPageDescription(await fetchPage(item.url));
      eventPagesRead++;
      if (description) item.description = description;
    } catch {
      eventPageFailures++;
    }
  }
  return { eventPagesRead, eventPageFailures };
}

/** All listings from a source; failed follow-up pages are ignored (snapshot script). */
export async function collectSource(source, checkedAt = new Date().toISOString()) {
  return (await collectSourcePages(source, checkedAt)).items;
}
const match = (s, re) => s.match(re)?.[1] || '';
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function localDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Winnipeg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
/** Friday-to-Sunday dates (YYYY-MM-DD) for "This weekend"; on a weekend day, the current one. */
export function weekendRange(today) {
  const date = new Date(today + 'T12:00:00Z');
  const weekday = date.getUTCDay();
  const daysToFriday = weekday === 0 ? -2 : weekday === 6 ? -1 : 5 - weekday;
  date.setUTCDate(date.getUTCDate() + daysToFriday);
  const first = date.toISOString().slice(0, 10);
  date.setUTCDate(date.getUTCDate() + 2);
  const last = date.toISOString().slice(0, 10);
  return { first, last };
}
function shortDates(s, year) {
  let m = [...s.matchAll(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})/g)];
  return m.map(
    (v, i) =>
      `${year + (i > 0 && months.indexOf(v[1]) < months.indexOf(m[0][1]) ? 1 : 0)}-${String(months.indexOf(v[1]) + 1).padStart(2, '0')}-${v[2].padStart(2, '0')}`,
  );
}
export const categoryFor = (title) => category(title);
function category(t) {
  return /paint|\bart\b|artist|craft|movie|film|blanche|ceremony|reconciliation|teaching|book/i.test(
    t,
  )
    ? 'Arts & culture'
    : /music|concert|orchestra|cello|Cody Johnson|Lyle Lovett|Bring Me The Horizon|^Journey$/i.test(
          t,
        )
      ? 'Music'
      : /food|supper|market/i.test(t)
        ? 'Food & drink'
        : /panda|zoo|tots|toddler|family/i.test(t)
          ? 'Family'
          : /garden|paddle|nature|fire|park/i.test(t)
            ? 'Outdoors'
            : 'Experiences';
}
export function parseSource(id, html, checkedAt = new Date().toISOString()) {
  if (id === freeSwimSource.id) return parseFreeSwim(html, checkedAt);
  if (id === 'attractions') return parsePlaces(html, checkedAt);
  const source = sources.find((s) => s.id === id);
  const year = +localDay(new Date(checkedAt)).slice(0, 4);
  let entries = [];
  if (id === 'forks')
    entries = html
      .split('<div class="event-listing">')
      .slice(1)
      .map((b) => {
        const title = clean(match(b, /<h3><a[^>]*>([\s\S]*?)<\/a>/));
        const dates = shortDates(clean(match(b, /<p class="dates">([\s\S]*?)<\/p>/)), year);
        return {
          title,
          url: new URL(match(b, /<h3><a href="([^"]+)"/), source.url).href,
          start: dates[0],
          end: dates.at(-1),
          venue: 'The Forks',
          address: clean(match(b, /<p class="location">([\s\S]*?)<\/p>/))
            .replace('Location:', '')
            .trim(),
          time: clean(match(b, /<p class="hours">([\s\S]*?)<\/p>/)),
          // The summary is the body paragraph without a class (dates, hours and location have one).
          description: [...b.matchAll(/<p(?![^>]*\bclass=)[^>]*>([\s\S]*?)<\/p>/g)]
            .map((paragraph) => paragraph[1])
            .join(' '),
          neighbourhood: 'The Forks',
          image: '',
          schedule: 'event',
        };
      });
  if (id === 'park')
    entries = html
      .split(/<div class="event-item\s+[^\"]*">/)
      .slice(1)
      .map((b) => {
        b = b.split('</div>\n\n</div>')[0];
        const title = clean(match(b, /<h3[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/));
        const dates = [...b.matchAll(/datetime="(\d{4}-\d{2}-\d{2})[^\"]*"/g)]
          .map((m) => m[1])
          .slice(0, 2);
        return {
          title,
          url: new URL(match(b, /<a href="([^"]+)"/), source.url).href,
          start: dates[0],
          end: dates.at(-1),
          venue: /leaf/i.test(title)
            ? 'The Leaf'
            : /zoo|panda/i.test(title)
              ? 'Assiniboine Park Zoo'
              : /class="leaf"/.test(b)
                ? 'The Leaf'
                : 'Assiniboine Park',
          address: 'Assiniboine Park, Winnipeg',
          time: '',
          neighbourhood: 'Assiniboine Park',
          description: match(b, /<div class="event-brief">([\s\S]*?)<\/div>/),
          image: new URL(match(b, /<img src="([^"]+)"/), source.url).href,
          schedule: /Red Panda Weekend/.test(title)
            ? 'event'
            : dates.length > 1 && dates[0] !== dates[1]
              ? 'series'
              : 'event',
        };
      })
      .filter((e) => !['Road Closures'].includes(e.title));
  if (id === 'manitoba')
    entries = [...html.matchAll(/<article class="card js-dir-item[\s\S]*?<\/article>/g)]
      .map(([b]) => {
        const title = clean(match(b, /<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/));
        const address = clean(match(b, /<p class="card__summary">([\s\S]*?)<\/p>/));
        const dates = shortDates(
          clean(match(b, /<div class="card__subtitle[^\"]*">([\s\S]*?)<\/div>/)),
          year,
        );
        return {
          title,
          url: new URL(match(b, /<a href="([^"]+)"/), source.url).href,
          start: dates[0],
          end: dates.at(-1),
          venue: address.replace(/,? Manitoba(?:\s+[A-Z]\d[A-Z].*)?$/, '').trim(),
          address,
          time: '',
          neighbourhood: 'Winnipeg',
          image: match(b, /data-src="([^"]+)"/),
          schedule: dates.length > 1 ? 'series' : 'event',
        };
      })
      .filter((e) => /Winnipeg/i.test(e.address));
  const unique = new Map();
  for (const e of entries) {
    if (!e.title || !e.start) continue;
    const key = e.url;
    if (unique.has(key)) continue;
    unique.set(key, {
      ...e,
      id: eventListingId(id, e.url),
      type: 'Event',
      category: category(e.title),
      source: id,
      sourceName: source.name,
      checkedAt,
      price: null,
      family: /family|tots|toddler|panda|craft|games|picnic/i.test(e.title),
      indoor: /leaf|movie|orchestra/i.test(e.venue + ' ' + e.title),
      description: summarize(e.description) || placeholderDescription(source.name),
      status: 'active',
    });
  }
  return [...unique.values()];
}
export function listingDedupeKey(item) {
  return (
    item.title
      .toLowerCase()
      .replace(/festial/g, 'festival')
      .replace(/[^a-z0-9]/g, '') +
    '|' +
    (item.start || '') +
    '|' +
    (/forks/i.test(item.venue)
      ? 'theforks'
      : /african movie festi[av]al in manitoba/i.test(item.title.replace('Festial', 'Festival'))
        ? 'african-film-festival'
        : item.venue.toLowerCase().replace(/[^a-z0-9]/g, '')) +
    (item.source === 'winnipeg-free-swim' ? '|' + item.time : '')
  );
}
export function dedupe(items) {
  const seen = new Map();
  for (const item of items) {
    const key = listingDedupeKey(item);
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
}
export function parsePlaces(html, checkedAt = new Date().toISOString()) {
  return html
    .split('<div class="attraction">')
    .slice(1)
    .filter((b) => !b.includes('<h2 id="seasonal">'))
    .map((b) => {
      const title = clean(match(b, /<h3>([\s\S]*?)<\/h3>/));
      const blurb = clean(match(b, /<div class="brief">\s*<p>([\s\S]*?)<\/p>/));
      const url = new URL(match(b, /<a href="([^"]+)"/), 'https://www.theforks.com').href;
      return {
        id: 'place-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        title,
        type: /tour|public art/i.test(title) ? 'Activity' : 'Place',
        category: /market|terminal/i.test(title)
          ? 'Food & drink'
          : /museum|art|centre|theatre|arch|wall/i.test(title)
            ? 'Arts & culture'
            : /arcade|playground/i.test(title)
              ? 'Family'
              : 'Outdoors',
        venue: title,
        address: 'The Forks, Winnipeg',
        neighbourhood: 'The Forks',
        time: 'Check visiting hours with the source',
        image: new URL(match(b, /<img src="([^"]+)"/), 'https://www.theforks.com').href,
        url,
        source: 'attractions',
        sourceName: 'The Forks',
        checkedAt,
        price: null,
        family: /children|playground/i.test(title),
        indoor: /market|museum|arcade|centre|terminal|theatre/i.test(title),
        description:
          'Discover this place at The Forks. See the original listing for visiting information and current availability.',
        schedule: 'evergreen',
        status: /currently closed/i.test(blurb) ? 'hidden' : 'active',
      };
    })
    .filter(
      (e) =>
        e.title &&
        !/Inn at|Visitor Information|Iceland|Nestaweya|Warming Huts|Winter Park|Waterways|Prairie Garden|Urban Garden/i.test(
          e.title,
        ),
    );
}
