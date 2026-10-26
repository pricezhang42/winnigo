import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { collectionWindow, zonedTimestamp } from '../event-schedule.mjs';
import { readLimited } from './request-body.mjs';
import { parseIcsEvents, addCalendarDay } from './ics.mjs';

export const CLC_ID = 'canada-life-centre';
export const CLC_CALENDAR = 'https://www.canadalifecentre.ca/calendar/';
export const CLC_FEED =
  'https://www.canadalifecentre.ca/?rhc_action=get_icalendar_events&post_type%5B%5D=events&taxonomy=calendar&terms=events%2Cjets_events%2Cmoose_events%2Csea_bears&ics=1';
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 24);
const clean = (value) =>
  load(String(value || ''))
    .text()
    .replace(/\s+/g, ' ')
    .trim();
export function clcEventUrl(value) {
  const u = new URL(value);
  if (
    u.origin !== 'https://www.canadalifecentre.ca' ||
    u.username ||
    u.password ||
    !/^\/calendar-events\/[^/]+\/$/.test(u.pathname)
  )
    throw Error('Refused non-Canada Life Centre event URL');
  u.search = '';
  u.hash = '';
  return u.href;
}
export function clcCalendarRequest(window) {
  const u = new URL(CLC_FEED);
  u.searchParams.set('rhc_action', 'get_calendar_events');
  u.searchParams.delete('ics');
  u.searchParams.set('start', String(Date.parse(zonedTimestamp(window.from, '00:00')) / 1000));
  u.searchParams.set(
    'end',
    String(Date.parse(zonedTimestamp(addCalendarDay(window.to), '00:00')) / 1000),
  );
  u.searchParams.set('view', 'month');
  return u.href;
}
export async function fetchClcText(url, { fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(url, {
    redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]),
    headers: {
      Accept: 'text/calendar,application/json;q=0.9',
      'User-Agent': 'Winnigo/1.0 (+local event collection)',
    },
  });
  if (!response.ok) throw Error('Source returned HTTP ' + response.status);
  const bytes = await readLimited(response.body, 4 * 1024 * 1024);
  if (!bytes) throw Error('Empty or oversized Canada Life Centre response');
  return Buffer.from(bytes).toString('utf8');
}
export function parseClcFeed(
  text,
  checkedAt = new Date().toISOString(),
  window = collectionWindow(checkedAt),
) {
  const parsed = parseIcsEvents(text, window),
    items = [],
    failedPages = [];
  for (const event of parsed.events) {
    try {
      const id = CLC_ID + '-' + hash(event.uid),
        url = clcEventUrl(event.url || event.occurrences[0].url);
      const title = clean(event.title);
      const occurrences = event.occurrences.map((o) => ({
        id: id + '-' + hash(o.recurrenceKey),
        start: o.start,
        end: o.end,
        ...(o.startAt ? { startAt: o.startAt, endAt: o.endAt } : {}),
        time: o.time,
        timeZone: o.timeZone,
        status: o.status,
        url: clcEventUrl(o.url || url),
        basis: 'calendar',
        ...(!o.durationKnown ? { endTimeKnown: false } : {}),
        ...(clean(o.title) !== title ||
        clean(o.description) !== clean(event.description) ||
        clean(o.location) !== clean(event.location)
          ? {
              sourceOverrides: {
                ...(clean(o.title) !== title ? { title: clean(o.title) } : {}),
                ...(clean(o.description) !== clean(event.description)
                  ? { description: clean(o.description).slice(0, 1200) }
                  : {}),
                ...(clean(o.location) !== clean(event.location)
                  ? { venue: clean(o.location) }
                  : {}),
              },
            }
          : {}),
      }));
      const first = occurrences[0];
      items.push({
        id,
        source: CLC_ID,
        sourceName: 'Canada Life Centre',
        sourceIdentity: 'ics:' + event.uid,
        checkedAt,
        title,
        url,
        eventUrl: url,
        type: 'Event',
        category: 'Experiences',
        venue: clean(event.location) || 'Canada Life Centre',
        address: '',
        neighbourhood: 'Downtown',
        description: (
          clean(event.description) ||
          `${title} at Canada Life Centre. See the event page for admission and details.`
        ).slice(0, 1200),
        price: null,
        indoor: true,
        image: '',
        images: [],
        provenance: 'ical',
        status: event.status,
        recurring: event.recurring,
        schedule: event.recurring ? 'series' : 'event',
        occurrences,
        ...(!event.recurring ? { start: first.start, end: first.end, time: first.time } : {}),
        scheduleCoverage: [
          {
            ...window,
            complete: !parsed.rejected.length,
            checkedAt,
            sourceUrl: CLC_FEED,
            basis: 'calendar',
          },
        ],
      });
    } catch (error) {
      failedPages.push({ url: CLC_FEED, error: error.message });
    }
  }
  for (const rejected of parsed.rejected)
    failedPages.push({ url: CLC_FEED, error: rejected.error });
  if (failedPages.length) for (const item of items) item.scheduleCoverage[0].complete = false;
  for (const item of items) item.occurrencesComplete = !failedPages.length;
  return {
    items,
    pagesRead: 1,
    failedPages,
    allowEmpty: !failedPages.length && !items.length,
    discovered: parsed.eventCount,
    occurrencesFound: items.reduce((n, e) => n + e.occurrences.length, 0),
    reviewRequired: failedPages.length,
    observedFrom: window.from,
    observedThrough: window.to,
  };
}
// Only media published on the venue's own upload origins may be downloaded.
export function clcPhotoUrl(value) {
  const u = new URL(value);
  const prefix =
    u.origin === 'https://d1kq1f9a6xp251.cloudfront.net'
      ? '/canadalifecentre/wp-content/uploads/'
      : u.origin === 'https://www.canadalifecentre.ca'
        ? '/wp-content/uploads/'
        : null;
  if (
    !prefix ||
    u.username ||
    u.password ||
    !u.pathname.startsWith(prefix) ||
    !/\.(png|jpe?g|webp)$/i.test(u.pathname)
  )
    throw Error('Refused unverified Canada Life Centre photo URL');
  u.hash = '';
  return u.href;
}

export function clcCalendarPhotos(text) {
  const data = JSON.parse(text);
  if (data.R !== 'OK' || !Array.isArray(data.EVENTS))
    throw Error('Unsupported Canada Life Centre calendar response');
  const photos = new Map();
  for (const event of data.EVENTS) {
    const url = clcEventUrl(event.url);
    if (typeof event.start !== 'string') throw Error('Calendar event dates unavailable');
    const start = event.allDay
      ? event.start.slice(0, 10)
      : zonedTimestamp(event.start.slice(0, 10), event.start.slice(11, 16));
    // These fields are size variants of one image, not separate gallery photos.
    const image = event.image_full?.[0] || event.image?.[0] || event.month_image?.[0];
    photos.set(url + '|' + start, image ? clcPhotoUrl(image) : null);
  }
  return photos;
}

async function fetchClcPhoto(url, { fetchImpl = fetch, signal } = {}) {
  clcPhotoUrl(url);
  const response = await fetchImpl(url, {
    redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]),
    headers: { Accept: 'image/png,image/jpeg,image/webp' },
  });
  if (!response.ok) throw Error('Photo returned HTTP ' + response.status);
  const data = await readLimited(response.body, 8 * 1024 * 1024);
  if (!data) throw Error('Empty or oversized Canada Life Centre photo');
  const bytes = Buffer.from(data);
  const contentType =
    bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? 'image/jpeg'
      : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? 'image/png'
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
          ? 'image/webp'
          : null;
  if (!contentType) throw Error('Canada Life Centre photo is not a supported image');
  return { bytes, contentType };
}

export async function collectClc(source, checkedAt = new Date().toISOString(), options = {}) {
  const window = options.window || collectionWindow(checkedAt);
  const result = parseClcFeed(await fetchClcText(CLC_FEED, options), checkedAt, window);
  if (!result.items.length) return result;
  const known = options.knownListings || new Map(),
    cache = new Map();
  const retain = (item) => {
    const old = known.get(item.id);
    const pairs = (old?.images || [])
      .map((image, i) => [image, old.sourceImages?.[i]])
      .filter(([image]) => /^\/api\/photos\/[a-f0-9]{64}$/.test(image))
      .slice(0, 3);
    item.images = pairs.map(([image]) => image);
    item.sourceImages = pairs.map(([, url]) => url);
    item.image = item.images[0] || '';
  };
  const calendarUrl = clcCalendarRequest(window);
  let photos;
  try {
    photos = clcCalendarPhotos(await fetchClcText(calendarUrl, options));
    result.pagesRead++;
  } catch {
    for (const item of result.items) retain(item);
    result.failedPages.push({ url: calendarUrl, error: 'Calendar photo metadata unavailable' });
    result.reviewRequired++;
    return result;
  }
  for (const item of result.items) {
    try {
      const urls = new Set();
      for (const o of item.occurrences.filter((o) => o.status === 'active')) {
        const key = o.url + '|' + (o.startAt || o.start);
        if (!photos.has(key)) throw Error('Photo metadata missing for performance');
        if (photos.get(key)) urls.add(photos.get(key));
      }
      item.sourceImages = [...urls].slice(0, 3);
      if (!options.storePhoto) continue; // Dry runs verify metadata without storing media.
      const images = [],
        old = known.get(item.id);
      for (const url of item.sourceImages) {
        let stored = cache.get(url);
        const oldIndex = old?.sourceImages?.indexOf(url) ?? -1;
        if (
          !stored &&
          oldIndex >= 0 &&
          /^\/api\/photos\/[a-f0-9]{64}$/.test(old.images?.[oldIndex] || '')
        )
          stored = old.images[oldIndex];
        if (!stored) stored = await options.storePhoto(await fetchClcPhoto(url, options));
        if (!/^\/api\/photos\/[a-f0-9]{64}$/.test(stored))
          throw Error('Invalid stored photo reference');
        cache.set(url, stored);
        images.push(stored);
      }
      item.images = images;
      item.image = images[0] || '';
    } catch {
      retain(item);
      result.failedPages.push({
        url: item.url,
        error: 'Event photo enrichment failed; previous photos retained',
      });
      result.reviewRequired++;
    }
  }
  return result;
}

/** Independent public-calendar comparison, keyed by canonical URL and actual instant. */
export function compareClcCalendar(result, text) {
  const data = JSON.parse(text);
  if (data.R !== 'OK' || !Array.isArray(data.EVENTS))
    throw Error('Unsupported Canada Life Centre calendar response');
  const feed = new Map(
    result.items.flatMap((e) =>
      e.occurrences
        .filter((o) => o.status === 'active')
        .map((o) => [o.url + '|' + (o.startAt || o.start), o.endAt || o.end]),
    ),
  );
  const calendar = new Map();
  for (const e of data.EVENTS) {
    if (typeof e.start !== 'string' || typeof e.end !== 'string')
      throw Error('Calendar event dates unavailable');
    const start = e.allDay
      ? e.start.slice(0, 10)
      : zonedTimestamp(e.start.slice(0, 10), e.start.slice(11, 16));
    const end = e.allDay
      ? addCalendarDay(e.end.slice(0, 10), -1)
      : zonedTimestamp(e.end.slice(0, 10), e.end.slice(11, 16));
    const day = e.start.slice(0, 10),
      endDay = e.end.slice(0, 10);
    if (day > result.observedThrough || endDay < result.observedFrom) continue;
    calendar.set(clcEventUrl(e.url) + '|' + start, end);
  }
  return {
    feed: feed.size,
    calendar: calendar.size,
    feedOnly: [...feed.keys()].filter((k) => !calendar.has(k)),
    calendarOnly: [...calendar.keys()].filter((k) => !feed.has(k)),
    differentEnds: [...feed.keys()].filter(
      (k) => calendar.has(k) && feed.get(k) !== calendar.get(k),
    ),
  };
}
