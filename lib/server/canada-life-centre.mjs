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
export async function collectClc(source, checkedAt = new Date().toISOString(), options = {}) {
  return parseClcFeed(
    await fetchClcText(CLC_FEED, options),
    checkedAt,
    options.window || collectionWindow(checkedAt),
  );
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
