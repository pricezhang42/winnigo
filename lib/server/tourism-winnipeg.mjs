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
  if (kind === 'organizer') {
    if (
      u.origin !== 'https://ccfm.mb.ca' ||
      u.username ||
      u.password ||
      u.search ||
      !/^\/en\/events\/[a-z0-9-]+\/$/i.test(u.pathname)
    )
      throw Error('Refused unverified organizer URL');
    u.hash = '';
    return u.href;
  }
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
    const thumb = ($(n).find('.event-thumb').attr('style') || '').match(/url\(['"]?([^)'"]+)/)?.[1];
    if (thumb) {
      try {
        const photo = tourismUrl(thumb, 'photo');
        for (const e of records.filter((e) => e.url === url)) e.photos.push(photo);
      } catch {}
    }
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
const MONTH_NAMES =
  'January February March April May June July August September October November December'.split(
    ' ',
  );
const MONTH_PATTERN = MONTH_NAMES.join('|');
export function annualDates(text) {
  const pattern = new RegExp(
    '\\b(' +
      MONTH_PATTERN +
      ')\\s+(\\d{1,2})(?:,\\s*(20\\d\\d))?\\s*(?:[-–—]|to)\\s*(?:(' +
      MONTH_PATTERN +
      ')\\s+)?(\\d{1,2}),?\\s*(20\\d\\d)\\b',
    'gi',
  );
  const ranges = [...text.matchAll(pattern)];
  let match = ranges.length === 1 ? ranges[0] : null;
  const day = (month, date, year) => {
    const m = MONTH_NAMES.findIndex((v) => v.toLowerCase() === month.toLowerCase()) + 1;
    const result =
      String(year) + '-' + String(m).padStart(2, '0') + '-' + String(date).padStart(2, '0');
    return validScheduleDay(result) ? result : null;
  };
  if (match) {
    const start = day(match[1], match[2], match[3] || match[6]),
      end = day(match[4] || match[1], match[5], match[6]);
    return start && end && end >= start ? { start, end } : null;
  }
  if (ranges.length) return null;
  const singles = [
    ...text.matchAll(
      new RegExp('\\b(' + MONTH_PATTERN + ')\\s+(\\d{1,2}),\\s*(20\\d\\d)\\b', 'gi'),
    ),
  ];
  match = singles.length === 1 ? singles[0] : null;
  if (match) {
    const start = day(match[1], match[2], match[3]);
    return start ? { start, end: start } : null;
  }
  return null;
}
// Recover the original run only when the narrative ends on a published source date.
export function tourismRunDates(text, expectedEnd) {
  if (!validScheduleDay(expectedEnd)) return null;
  const pattern = new RegExp(
    '\\bfrom\\s+(' +
      MONTH_PATTERN +
      ')\\s+(\\d{1,2})(?:,\\s*(20\\d\\d))?\\s+(?:to|through)\\s+(' +
      MONTH_PATTERN +
      ')\\s+(\\d{1,2})(?:,?\\s+(20\\d\\d))?',
    'gi',
  );
  const found = [];
  for (const m of text.matchAll(pattern)) {
    const endYear = m[6] || m[3] || expectedEnd.slice(0, 4);
    const range = annualDates(`${m[1]} ${m[2]}, ${m[3] || endYear} to ${m[4]} ${m[5]}, ${endYear}`);
    if (range?.end === expectedEnd) found.push(range);
  }
  const unique = new Map(found.map((r) => [r.start + '|' + r.end, r]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}
const titleWords = (value) =>
  new Set(
    clean(value)
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .match(/[a-z0-9]{4,}/g)
      ?.filter((w) => !['exposition', 'exhibition', 'gallery', 'event', 'events'].includes(w)) ||
      [],
  );
export function parseTourismOrganizer(html, url, title) {
  tourismUrl(url, 'organizer');
  const $ = load(html),
    heading = $('h1').text();
  const words = titleWords(title),
    headWords = titleWords(heading);
  const shorter = words.size < headWords.size ? words : headWords,
    longer = words.size < headWords.size ? headWords : words;
  if (!shorter.size || ![...shorter].every((w) => longer.has(w)))
    throw Error('Organizer event title does not match');
  const fields = new Map();
  $('.event-detail-row').each((_, n) => {
    const row = $(n),
      label = clean(row.find('.titre-ligne-event-details').text());
    const content = row.clone();
    content.find('.titre-ligne-event-details').remove();
    fields.set(label.toLowerCase(), clean(content.text()));
  });
  const dates = annualDates(fields.get('dates') || '');
  if (!dates) throw Error('Organizer event dates missing or ambiguous');
  const hours = fields.get('hours') || fields.get('time') || '';
  return { ...dates, sourceUrl: url, allDay: /^all day$/i.test(hours) };
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
  const rawTime = clean(datesNode.text());
  const time = /\b(?:[ap]\.?m\.?|noon|midnight)\b|\b(?:[01]?\d|2[0-3]):[0-5]\d\b/i.test(rawTime)
    ? rawTime
    : '';
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
  const contactText = clean(contact.html()?.replace(/<br\s*\/?>/gi, ' ') || '');
  const venue = clean(contactText.match(/Venue:\s*(.*?)(?=Address:|Tel:|Email:|URL:|$)/i)?.[1]);
  const website = contact
    .find('a')
    .filter((_, n) => /Visit Website/i.test($(n).text()))
    .first()
    .attr('href');
  const exactDates = annual
    ? annualDates(
        clean(
          body
            .find('p')
            .slice(0, 3)
            .map((_, n) => $(n).text())
            .get()
            .join(' '),
        ),
      )
    : null;
  const fullText = clean(body.html()?.replace(/<\/p>/gi, ' </p>') || '');
  const records = annual ? [] : events($);
  const exhibitionText = (title + ' ' + fullText).replace(/Exhibition Park/gi, '');
  const isExhibition =
    /\b(?:exhibitions?|exposition|exhibit)\b/i.test(exhibitionText) ||
    (/gallery|galerie|museum|WAG/i.test(venue) && /\bcollection of works\b/i.test(fullText));
  const lastEnd = records
    .map((e) => e.end)
    .sort()
    .at(-1);
  const runDates = isExhibition ? tourismRunDates(fullText, lastEnd) : null;
  return {
    title,
    time,
    description: fullText.slice(0, 1200),
    isExhibition,
    allDay: /\ball day\b|toute la journ[eé]e/i.test(rawTime),
    runDates,
    dateLabel,
    photos,
    venue,
    website,
    eventLinks,
    exactDates,
    records,
    price: /Tickets:\s*Free\b/i.test(contactText) ? 0 : null,
  };
}
function combineOrganizerAliases(result) {
  const removed = new Set();
  for (const canonical of result.items) {
    if (!canonical.runDates || canonical.runDates.sourceUrl !== canonical.officialUrl) continue;
    for (const alias of result.items) {
      if (
        alias === canonical ||
        !alias.runDates ||
        alias.runDates.start !== canonical.runDates.start ||
        alias.runDates.end !== canonical.runDates.end
      )
        continue;
      let a, c;
      try {
        a = new URL(alias.officialUrl);
        c = new URL(canonical.officialUrl);
      } catch {
        continue;
      }
      if (
        a.origin !== c.origin ||
        !['/', '/en/', '/fr/'].includes(a.pathname) ||
        ['/', '/en/', '/fr/'].includes(c.pathname)
      )
        continue;
      if (clean(alias.venue).toLowerCase() !== clean(canonical.venue).toLowerCase()) continue;
      const aw = titleWords(alias.title),
        cw = titleWords(canonical.title),
        shorter = aw.size < cw.size ? aw : cw,
        longer = aw.size < cw.size ? cw : aw;
      if (!shorter.size || ![...shorter].every((w) => longer.has(w))) continue;
      canonical.sourceLinks = [
        ...new Set([...(canonical.sourceLinks || []), alias.url, ...(alias.sourceLinks || [])]),
      ];
      removed.add(alias.id);
      result.supersededIds.push(alias.id);
    }
  }
  result.items = result.items.filter((e) => !removed.has(e.id));
  result.organizerAliases = removed.size;
  result.reviewRequired = result.items.filter((e) => e.status === 'hidden').length;
  result.occurrencesFound = result.items.reduce((n, e) => n + (e.occurrences?.length || 0), 0);
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
    supersededIds: [],
    organizerPagesRead: 0,
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
      lastPage = Math.max(lastPage, parsed.lastPage);
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
      lastPage = Math.max(lastPage, parsed.lastPage);
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
  const completeCalendar = !result.failedPages.length;
  let detailsComplete = true;
  result.annualEntries = annual.size;
  const published = new Map();
  for (const [identity, map] of groups) {
    const entries = [...map.values()].sort((a, b) => a.start.localeCompare(b.start)),
      first = entries[0],
      item = baseItem(first, checkedAt);
    let detail, organizer;
    try {
      detail = parseTourismDetail((await read(first.url)).toString('utf8'), first.url);
      result.eventPagesRead++;
      if (detail.title !== first.title) throw Error('Tourism Winnipeg detail identity changed');
      item.description = detail.description;
      item.venue = detail.venue || item.venue;
      item.price = detail.price;
      item.officialUrl = detail.website;
      if (detail.isExhibition && detail.website) {
        let linked;
        try {
          linked = tourismUrl(detail.website, 'organizer');
        } catch {}
        if (linked) {
          organizer = parseTourismOrganizer(
            (await read(linked, 'organizer')).toString('utf8'),
            linked,
            first.title,
          );
          result.organizerPagesRead++;
        }
      }
    } catch (error) {
      detailsComplete = false;
      result.failedPages.push({ url: first.url, error: error.message });
    }
    const exhibition = detail?.isExhibition || false;
    const previousRun = knownListings.get(item.id)?.runDates;
    const cachedRun =
      previousRun?.sourceUrl === detail?.website && previousRun?.end === entries.at(-1).end
        ? previousRun
        : null;
    const continuousAllDay =
      exhibition && (organizer?.allDay || detail?.allDay || cachedRun?.allDay);
    const runDates = organizer || detail?.runDates || cachedRun;
    if (runDates)
      item.runDates = {
        start: runDates.start,
        end: runDates.end,
        sourceUrl: runDates.sourceUrl || first.url,
        checkedAt: runDates.checkedAt || checkedAt,
        ...(continuousAllDay ? { allDay: true } : {}),
      };
    const broadExhibition =
      exhibition &&
      !continuousAllDay &&
      entries.some((e) => (Date.parse(e.end) - Date.parse(e.start)) / 86400000 > 6);
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
              time: continuousAllDay ? '' : detail?.time || '',
              cancelled: e.cancelled,
              basis: 'calendar',
            },
            item,
          ),
        ]),
      ).values(),
    ];
    if (!item.recurring) Object.assign(item, { start: first.start, end: first.end });
    if (item.runDates) Object.assign(item, { start: item.runDates.start, end: item.runDates.end });
    if (continuousAllDay)
      item.hoursNote = 'Source lists an all-day exhibition; exact gallery hours are unconfirmed';
    item.occurrencesComplete = completeCalendar && Boolean(detail);
    item.scheduleCoverage = [
      {
        ...window,
        checkedAt,
        complete: completeCalendar && Boolean(detail),
        sourceUrl: TOURISM_CALENDAR,
        basis: 'calendar',
      },
    ];
    const primaryPhotos = detail?.photos.length ? detail.photos : entries.flatMap((e) => e.photos);
    try {
      await collectEventPhotos(item, primaryPhotos, { read, storePhoto, cache });
    } catch {
      const fallback = entries.flatMap((e) => e.photos).filter((u) => !primaryPhotos.includes(u));
      try {
        if (!fallback.length) throw Error('No calendar fallback');
        await collectEventPhotos(item, fallback, { read, storePhoto, cache });
        item.photoNote = 'Detail image unavailable; using the published calendar image';
      } catch {
        retainEventPhotos(item, knownListings.get(item.id));
        result.failedPages.push({
          url: first.url,
          error: 'Tourism Winnipeg photos failed; previous media retained',
        });
      }
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
      if (!matches.length && detail.exactDates) {
        const candidates = [...published].filter(
          ([, e]) =>
            e.title.toLowerCase() === detail.title.toLowerCase() &&
            e.occurrences[0]?.start === detail.exactDates.start &&
            e.occurrences.at(-1)?.end === detail.exactDates.end,
        );
        if (candidates.length === 1) matches.push(candidates[0][0]);
      }

      // Explicit links or one identical title and confirmed edition range establish the same annual entry.
      if (matches.length) {
        for (const id of matches) {
          const item = published.get(id);
          item.sourceLinks = [...new Set([...(item.sourceLinks || []), record.url])];
        }
        result.annualMatched++;
        result.supersededIds.push(baseItem(record, checkedAt).id);
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
      detailsComplete = false;
      result.failedPages.push({ url: record.url, error: error.message });
    }
  }
  combineOrganizerAliases(result);
  result.completeSchedules = completeCalendar && detailsComplete;
  result.discovered = groups.size + annual.size;
  result.allowEmpty = !result.failedPages.length && !result.items.length;
  return result;
}
