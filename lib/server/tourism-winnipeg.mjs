import { load } from 'cheerio';
import { eventListingId } from '../connectors.mjs';
import { collectionWindow, validScheduleDay, normalizeOccurrence } from '../event-schedule.mjs';
import {
  cleanEventText as clean,
  sourceReader,
  storedPhotoCache,
  collectEventPhotos,
  retainEventPhotos,
} from './public-event-collector.mjs';
export const TOURISM_ID = 'tourism-winnipeg';
export const TOURISM_BASE = 'https://www.tourismwinnipeg.com/festivals-and-events/';
export const TOURISM_CALENDAR = TOURISM_BASE + 'upcoming-events';
export const TOURISM_ANNUAL = TOURISM_BASE + 'annual-festivals-and-events';
export function tourismUrl(value, kind = 'page') {
  const u = new URL(value, TOURISM_BASE);
  const path =
    kind === 'photo'
      ? /^\/uploads\/(?:event_image|sv_images|tmp)\/[^/]+\.(?:jpe?g|png|webp)$/i
      : /^\/festivals-and-events\/(?:upcoming-events|annual-festivals-and-events)(?:\/(?:filter:[A-Za-z0-9_-]+(?:\/page:\d+)?|page:\d+|display,(?:event|listing)\/\d+(?:\/[^/]+)?))?\/?$/;
  if (
    u.origin !== 'https://www.tourismwinnipeg.com' ||
    u.username ||
    u.password ||
    !path.test(u.pathname)
  )
    throw Error('Refused non-Tourism Winnipeg source URL');
  u.hash = '';
  u.search = '';
  return u.href;
}
const idOf = (u) =>
  u
    .match(/display,(event|listing)\/(\d+)/)
    ?.slice(1)
    .join(':');
const nextDay = (d) => new Date(Date.parse(d + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
export function tourismFilter(window) {
  const body = new URLSearchParams();
  for (const [key, value] of [
    ['s', window.from],
    ['e', window.to],
  ]) {
    const [year, month, day] = value.split('-');
    for (const [part, v] of Object.entries({ year, month, day }))
      body.set(`data[F][${key}][${part}]`, v);
  }
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  };
}
function pagination($, base) {
  const links = [
    ...new Set(
      $('#content a[href*="/page:"]')
        .map((_, n) => tourismUrl($(n).attr('href')))
        .get(),
    ),
  ];
  if (links.some((u) => !u.startsWith(base)))
    throw Error('Tourism Winnipeg pagination changed section');
  return { links, lastPage: Math.max(1, ...links.map((u) => Number(u.match(/page:(\d+)/)[1]))) };
}
function events($) {
  const result = [];
  $('#content script[type="application/ld+json"]').each((_, n) => {
    const parsed = JSON.parse($(n).text());
    for (const e of Array.isArray(parsed) ? parsed : [parsed])
      if (e['@type'] === 'Event') {
        const url = tourismUrl(e.url);
        if (!idOf(url)?.startsWith('event:'))
          throw Error('Invalid Tourism Winnipeg event identity');
        const start = e.startDate,
          end = e.endDate || start;
        if (!validScheduleDay(start) || !validScheduleDay(end) || end < start)
          throw Error('Invalid Tourism Winnipeg event date');
        const title = clean(e.name);
        if (!title) throw Error('Missing Tourism Winnipeg event title');
        const location = e.location || {},
          a = location.address || {};
        const photos = [e.image]
          .flat()
          .filter(Boolean)
          .flatMap((u) => {
            try {
              return [tourismUrl(typeof u === 'string' ? u : u.url, 'photo')];
            } catch {
              return [];
            }
          });
        result.push({
          identity: idOf(url),
          url,
          title,
          start,
          end,
          description: clean(e.description),
          venue: clean(location.name),
          address: clean(
            [a.streetAddress, a.addressLocality, a.addressRegion].filter(Boolean).join(', '),
          ),
          photos,
          cancelled: /EventCancelled$/.test(e.eventStatus || ''),
        });
      }
  });
  return result;
}
export function parseTourismCalendar(html, window) {
  const $ = load(html);
  for (const [key, value] of [
    ['s', window.from],
    ['e', window.to],
  ]) {
    const [year, month, day] = value.split('-');
    for (const [part, v] of Object.entries({ year, month, day }))
      if ($(`[name="data[F][${key}][${part}]"]`).val() !== v)
        throw Error('Tourism Winnipeg returned a different date filter');
  }
  const records = events($),
    cards = $('#content .event-list > li');
  if (!cards.length && !/no events|no results/i.test($('#content').text()))
    throw Error('Tourism Winnipeg calendar layout changed');
  cards.each((_, n) => {
    const url = tourismUrl($(n).find('a.title').attr('href'));
    if (!records.some((e) => e.url === url))
      throw Error('Tourism Winnipeg calendar card has no structured dates');
  });
  return { records, cards: cards.length, ...pagination($, TOURISM_CALENDAR) };
}
export function parseTourismAnnual(html) {
  const $ = load(html),
    records = [];
  $('#content .profile-list > li').each((_, n) => {
    const a = $(n).find('a.title').first(),
      url = tourismUrl(a.attr('href'));
    if (!idOf(url)?.startsWith('listing:')) throw Error('Invalid annual festival identity');
    records.push({ url, title: clean(a.text()), identity: idOf(url) });
  });
  if (!records.length) throw Error('Tourism Winnipeg annual directory layout changed');
  return { records, ...pagination($, TOURISM_ANNUAL) };
}
// Annual repetition and month/season labels do not establish an edition's exact dates.
export function parseTourismDetail(html, url) {
  const $ = load(html),
    annual = idOf(url)?.startsWith('listing:'),
    block = $('#content'),
    body = block
      .find(annual ? '.profile-description-block .body' : '.event-description-block .body')
      .first()
      .clone();
  if (!block.find('#page-image').length || !body.length)
    throw Error('Tourism Winnipeg detail layout changed');
  body.find('.actions,script,style').remove();
  const title = clean(block.find('.profile-image-block h2,.event-image-block h2').first().text());
  if (!title) throw Error('Missing Tourism Winnipeg detail title');
  const datesNode = body.find('.dates').clone();
  datesNode.find('strong').remove();
  const time = clean(datesNode.text());
  const dateLabel = clean(body.find('.dates').text() || body.find('p').first().text());
  body.find('.dates').remove();
  const photos = block
    .find('#page-image img')
    .map((_, n) => {
      try {
        return tourismUrl($(n).attr('src'), 'photo');
      } catch {
        return null;
      }
    })
    .get();
  const eventLinks = body
    .find('a[href*="/upcoming-events/display,event/"]')
    .map((_, n) => tourismUrl($(n).attr('href')))
    .get();
  const contact = block.find('.contact-details').first();
  const contactText = clean(contact.text());
  const venue = clean(contactText.match(/Venue:\s*(.*?)(?=Tel:|Email:|URL:|$)/i)?.[1]);
  const website = contact
    .find('a')
    .filter((_, n) => /Visit Website/i.test($(n).text()))
    .first()
    .attr('href');
  let exactDates = null;
  if (annual) {
    const m = dateLabel.match(
      /^([A-Za-z]+)\s+(\d{1,2})(?:\s*[-–]\s*(?:([A-Za-z]+)\s+)?(\d{1,2}))?,\s*(20\d\d)$/,
    );
    if (m) {
      const start = new Date(`${m[1]} ${m[2]}, ${m[5]} 12:00:00 GMT`),
        end = new Date(`${m[3] || m[1]} ${m[4] || m[2]}, ${m[5]} 12:00:00 GMT`);
      if (Number.isFinite(+start) && Number.isFinite(+end)) {
        const from = start.toISOString().slice(0, 10),
          to = end.toISOString().slice(0, 10);
        if (validScheduleDay(from) && validScheduleDay(to) && to >= from)
          exactDates = { start: from, end: to };
      }
    }
  }
  return {
    title,
    time,
    description: clean(body.text()).slice(0, 1200),
    dateLabel,
    photos,
    venue,
    website,
    eventLinks,
    exactDates,
    records: annual ? [] : events($),
    price: /Tickets:\s*Free\b/i.test(contactText) ? 0 : null,
  };
}
function baseItem(record, checkedAt) {
  return {
    id: eventListingId(TOURISM_ID, record.url.replace(/(display,(?:event|listing)\/\d+).*$/, '$1')),
    source: TOURISM_ID,
    sourceName: 'Tourism Winnipeg',
    sourceIdentity: 'tourism:' + record.identity,
    checkedAt,
    title: record.title,
    url: record.url,
    eventUrl: record.url.replace(/(display,(?:event|listing)\/\d+).*$/, '$1'),
    type: 'Event',
    category: 'Arts & Culture',
    venue: record.venue || '',
    address: record.address || '',
    neighbourhood: 'Winnipeg',
    description: record.description || 'See the source for event details.',
    price: null,
    status: 'active',
    images: [],
    image: '',
    sourceImages: [],
  };
}
export async function collectTourism(source, checkedAt = new Date().toISOString(), options = {}) {
  const { knownListings = new Map(), storePhoto, maxPages = 40, maxAnnualPages = 5 } = options,
    window = collectionWindow(checkedAt),
    read = sourceReader({
      maxRunMs: 1140000,
      maxRequests: 800,
      ...options,
      validateUrl: tourismUrl,
    }),
    cache = storedPhotoCache(knownListings, tourismUrl);
  const result = {
    items: [],
    pagesRead: 0,
    eventPagesRead: 0,
    failedPages: [],
    allowEmpty: false,
    discovered: 0,
    occurrencesFound: 0,
    reviewRequired: 0,
    observedFrom: window.from,
    observedThrough: window.to,
    calendarCards: 0,
    annualEntries: 0,
    annualMatched: 0,
  };
  const groups = new Map();
  let url = TOURISM_CALENDAR,
    page = 1,
    lastPage = 1,
    filterPrefix;
  while (page <= Math.min(lastPage, maxPages)) {
    try {
      const parsed = parseTourismCalendar(
        (await read(url, 'page', page === 1 ? tourismFilter(window) : {})).toString('utf8'),
        window,
      );
      result.pagesRead++;
      result.calendarCards += parsed.cards;
      lastPage = parsed.lastPage;
      if (parsed.links.length) {
        const prefixes = new Set(parsed.links.map((u) => u.replace(/\/page:\d+\/?$/, '')));
        if (prefixes.size !== 1) throw Error('Conflicting Tourism Winnipeg pagination filters');
        const prefix = [...prefixes][0];
        if (!prefix.includes('/filter:') || (filterPrefix && prefix !== filterPrefix))
          throw Error('Tourism Winnipeg pagination lost date filter');
        filterPrefix = prefix;
      }
      for (const e of parsed.records) {
        if (e.end < window.from || e.start > window.to) continue;
        const group = groups.get(e.identity) || new Map();
        group.set(e.start + '|' + e.end, e);
        groups.set(e.identity, group);
      }
      page++;
      url = filterPrefix + '/page:' + page;
    } catch (error) {
      if (!result.pagesRead) throw error;
      result.failedPages.push({ url, error: error.message });
      break;
    }
  }
  if (lastPage > maxPages)
    result.failedPages.push({ url, error: 'Tourism Winnipeg calendar page limit reached' });
  const annual = new Map();
  lastPage = 1;
  for (let p = 1; p <= Math.min(lastPage, maxAnnualPages); p++) {
    const annualUrl = TOURISM_ANNUAL + (p === 1 ? '' : '/page:' + p);
    try {
      const parsed = parseTourismAnnual((await read(annualUrl)).toString('utf8'));
      result.pagesRead++;
      lastPage = parsed.lastPage;
      for (const e of parsed.records) annual.set(e.identity, e);
    } catch (error) {
      result.failedPages.push({ url: annualUrl, error: error.message });
      break;
    }
  }
  if (lastPage > maxAnnualPages)
    result.failedPages.push({
      url: TOURISM_ANNUAL,
      error: 'Tourism Winnipeg annual page limit reached',
    });
  result.annualEntries = annual.size;
  const published = new Map();
  for (const [identity, map] of groups) {
    const entries = [...map.values()].sort((a, b) => a.start.localeCompare(b.start)),
      first = entries[0],
      item = baseItem(first, checkedAt);
    let detail;
    try {
      detail = parseTourismDetail((await read(first.url)).toString('utf8'), first.url);
      result.eventPagesRead++;
      if (detail.title !== first.title) throw Error('Tourism Winnipeg detail identity changed');
      item.description = detail.description;
      item.venue = detail.venue || item.venue;
      item.price = detail.price;
      item.officialUrl = detail.website;
    } catch (error) {
      result.failedPages.push({ url: first.url, error: error.message });
    }
    const exhibition = /\bexhibition\b/i.test(item.title + ' ' + item.description);
    const broadExhibition =
      exhibition && entries.some((e) => (Date.parse(e.end) - Date.parse(e.start)) / 86400000 > 6);
    const dates = [];
    for (const e of entries) {
      if (exhibition && !broadExhibition) {
        for (
          let d = e.start < window.from ? window.from : e.start;
          d <= e.end && d <= window.to;
          d = nextDay(d)
        )
          dates.push({ ...e, start: d, end: d });
      } else dates.push(e);
    }
    item.recurring = dates.length > 1 && !broadExhibition;
    item.schedule = item.recurring ? 'series' : 'event';
    if (broadExhibition) {
      item.status = 'hidden';
      item.reviewReason = 'Exhibition visiting days need verification';
      result.reviewRequired++;
    }
    item.occurrences = [
      ...new Map(
        dates.map((e) => [
          e.start + '|' + e.end,
          normalizeOccurrence(
            {
              start: e.start,
              end: e.end,
              url: e.url,
              time: detail?.time || '',
              cancelled: e.cancelled,
              basis: 'calendar',
            },
            item,
          ),
        ]),
      ).values(),
    ];
    if (!item.recurring) Object.assign(item, { start: first.start, end: first.end });
    item.occurrencesComplete = !result.failedPages.length;
    item.scheduleCoverage = [
      {
        ...window,
        checkedAt,
        complete: !result.failedPages.length,
        sourceUrl: TOURISM_CALENDAR,
        basis: 'calendar',
      },
    ];
    try {
      await collectEventPhotos(
        item,
        detail?.photos.length ? detail.photos : entries.flatMap((e) => e.photos),
        { read, storePhoto, cache },
      );
    } catch {
      retainEventPhotos(item, knownListings.get(item.id));
      result.failedPages.push({
        url: first.url,
        error: 'Tourism Winnipeg photos failed; previous media retained',
      });
    }
    result.items.push(item);
    published.set(identity, item);
    result.occurrencesFound += item.occurrences.length;
  }
  for (const record of annual.values()) {
    try {
      const detail = parseTourismDetail((await read(record.url)).toString('utf8'), record.url);
      result.eventPagesRead++;
      const matches = detail.eventLinks.map(idOf).filter((id) => published.has(id));
      // Only explicit cross-links establish the same event; names alone cannot distinguish editions.
      if (matches.length) {
        for (const id of matches) {
          const item = published.get(id);
          item.sourceLinks = [...new Set([...(item.sourceLinks || []), record.url])];
        }
        result.annualMatched++;
        continue;
      }
      const e = { ...record, ...detail };
      if (detail.exactDates) Object.assign(e, detail.exactDates);
      if (e.start && (e.end < window.from || e.start > window.to)) continue;
      const item = baseItem(e, checkedAt);
      item.officialUrl = detail.website;
      item.dateLabel = detail.dateLabel;
      item.price = detail.price;
      if (!e.start) {
        item.type = 'Activity';
        item.status = 'hidden';
        item.reviewReason = 'Annual edition dates need verification';
        result.reviewRequired++;
      } else {
        item.start = e.start;
        item.end = e.end;
        item.occurrences = [
          normalizeOccurrence({ start: e.start, end: e.end, url: e.url, basis: 'event' }, item),
        ];
        result.occurrencesFound++;
      }
      item.recurring = false;
      item.schedule = 'event';
      try {
        await collectEventPhotos(item, detail.photos, { read, storePhoto, cache });
      } catch {
        retainEventPhotos(item, knownListings.get(item.id));
        result.failedPages.push({
          url: e.url,
          error: 'Annual festival photos failed; previous media retained',
        });
      }
      result.items.push(item);
    } catch (error) {
      result.failedPages.push({ url: record.url, error: error.message });
    }
  }
  result.discovered = groups.size + annual.size;
  result.allowEmpty = !result.failedPages.length && !result.items.length;
  return result;
}
