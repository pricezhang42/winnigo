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
export async function collectSource(source, checkedAt = new Date().toISOString()) {
  const getHtml = async (url) => {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Winnigo/1.0 (Winnipeg discovery; source-attributed listings)' },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw Error('Source returned HTTP ' + response.status);
    const html = await response.text();
    if (html.length > 2_000_000) throw Error('Unexpected source size');
    return html;
  };
  if (source.id === freeSwimSource.id) {
    const [html, pools] = await Promise.all([getHtml(source.url), getHtml(poolDirectoryUrl)]);
    return applyPoolClosures(parseFreeSwim(html, checkedAt), pools);
  }
  return parseSource(source.id, await getHtml(source.url), checkedAt);
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
function shortDates(s, year) {
  let m = [...s.matchAll(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})/g)];
  return m.map(
    (v, i) =>
      `${year + (i > 0 && months.indexOf(v[1]) < months.indexOf(m[0][1]) ? 1 : 0)}-${String(months.indexOf(v[1]) + 1).padStart(2, '0')}-${v[2].padStart(2, '0')}`,
  );
}
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
      id: id + '-' + e.url.split('/').filter(Boolean).at(-1) + '-' + e.start,
      type: 'Event',
      category: category(e.title),
      source: id,
      sourceName: source.name,
      checkedAt,
      price: null,
      family: /family|tots|toddler|panda|craft|games|picnic/i.test(e.title),
      indoor: /leaf|movie|orchestra/i.test(e.venue + ' ' + e.title),
      description: `See ${source.name} for the full program, availability and admission details.`,
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
