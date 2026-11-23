// Shared text and date helpers, and the one non-event public source: The Forks' places page.
// Events are collected by AI extraction from config/sources.mjs (docs/30).
const match = (s, re) => s.match(re)?.[1] || '';

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

export const DESCRIPTION_LIMIT = 600;

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

/** A listing's duplicate key: the same title, start and venue across sources is one card. */
export function listingDedupeKey(item) {
  const plain = (text) =>
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  return [plain(item.title), item.start || '', plain(item.venue)].join('|');
}

/** Places collected by the worker; they are listings, not events. */
export const placeSources = [
  {
    id: 'attractions',
    name: 'The Forks · places',
    url: 'https://www.theforks.com/attractions',
    // Cron in America/Winnipeg, like the event source list (config/sources.mjs).
    schedule: '0 6 * * *',
  },
];

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

/** Reads a places source: one page, parsed into evergreen place listings. */
export async function collectPlaces(source, checkedAt, { fetchPage = fetchSourcePage } = {}) {
  if (source.id !== 'attractions') throw Error('Unknown places source');
  return {
    items: parsePlaces(await fetchPage(source.url), checkedAt),
    pagesRead: 1,
    failedPages: [],
  };
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
