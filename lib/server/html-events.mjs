// HTML calendars share the extraction contract; their existing parsers remain the fallback.
import { load } from 'cheerio';
import { preserveCalendarTimes } from './calendar-enrichment.mjs';
import {
  collectSourcePages,
  eventListingId,
  placeholderDescription,
  parseSource,
} from '../connectors.mjs';
import { collectionWindow, normalizeEvents, normalizeOccurrence } from '../event-schedule.mjs';
import {
  sourceReader,
  storedPhotoCache,
  collectEventPhotos,
  retainEventPhotos,
} from './public-event-collector.mjs';

export const HTML_EVENT_SOURCES = new Set(['forks', 'park', 'manitoba']);
const cards = { forks: '.event-listing', park: '.event-item', manitoba: 'article.js-dir-item' };
const focus = { forks: 'main', park: '.event-view', manitoba: '.area-intro, main' };

export function htmlEventUrl(source, value, kind = 'page') {
  const url = new URL(value, source.url);
  const path =
    kind === 'photo'
      ? /\/(?:uploads|imager)\/.*\.(?:jpe?g|png|webp|gif)$/i
      : source.id === 'forks'
        ? /^\/events\/calendar-of-events(?:\/|$)/
        : /^\/events(?:\/|$)/;
  if (
    !HTML_EVENT_SOURCES.has(source.id) ||
    url.origin !== new URL(source.url).origin ||
    url.username ||
    url.password ||
    !path.test(url.pathname)
  )
    throw Error('Refused event source URL');
  url.hash = '';
  return url.href;
}

/** Current and next month only, including the native fallback when extraction is disabled. */
export function boundedHtmlEvents(items, checkedAt) {
  const window = collectionWindow(checkedAt);
  return normalizeEvents(items, checkedAt, { bounded: true }).filter((item) => {
    if (item.type === 'Activity') return true;
    if (item.occurrences?.length) {
      item.occurrences = item.occurrences.filter(
        (row) => row.end >= window.from && row.start <= window.to,
      );
      return item.occurrences.length > 0;
    }
    return item.start <= window.to && (item.end || item.start) >= window.from;
  });
}

export async function collectHtmlEvents(source, checkedAt, options = {}) {
  const { onEventPage, knownListings = new Map(), storePhoto, maxEventPages = 100 } = options;
  const validateUrl = (value, kind) => htmlEventUrl(source, value, kind);
  const read = sourceReader({ maxRunMs: 300000, maxRequests: 350, ...options, validateUrl });
  const pages = new Map();
  const fetchPage = async (url) => {
    const html = (await read(url)).toString('utf8');
    pages.set(url, html);
    return html;
  };
  const window = collectionWindow(checkedAt);
  const result = await collectSourcePages(source, checkedAt, {
    ...options,
    fetchPage,
    pauseMs: 0,
    ...(source.id === 'forks'
      ? {
          monthUrls: [window.from, window.to].map(
            (day) => source.url + '/list/' + day.slice(0, 4) + '/' + day.slice(5, 7),
          ),
        }
      : {}),
  });
  if (source.id === 'forks') {
    // One detail URL can appear on both month pages. Preserve every printed calendar
    // interval instead of letting the first URL hide later dates or a broad detail range.
    const intervals = new Map();
    for (const html of pages.values())
      for (const entry of parseSource(source.id, html, checkedAt)) {
        const rows = intervals.get(entry.url) || new Map();
        rows.set(entry.start + '|' + entry.end, entry);
        intervals.set(entry.url, rows);
      }
    for (const item of result.items) {
      const entries = [...(intervals.get(item.url)?.values() || [])];
      item.occurrences = entries.map((entry) =>
        normalizeOccurrence(
          {
            start: entry.start,
            end: entry.end,
            time: entry.time,
            url: entry.url,
            basis: 'calendar',
            id:
              knownListings
                .get(item.id)
                ?.occurrences?.find((o) => o.start === entry.start && o.end === entry.end)?.id ||
              (entries.length === 1 ? item.id : undefined),
          },
          item,
        ),
      );
    }
  }
  const evidence = new Map();
  for (const [url, html] of pages) {
    const $ = load(html);
    $(cards[source.id]).each((_, node) => {
      const card = $(node),
        title = card.find('h3').first().text().trim();
      if (source.id === 'manitoba' && !/Winnipeg/i.test(card.find('.card__summary').text())) return;
      const href =
        source.id === 'forks'
          ? card.find('a[href*="/events/calendar-of-events/event/"]').first().attr('href')
          : card.find('h3 a').first().attr('href');
      if (!href || !title) return;
      try {
        const eventUrl = validateUrl(href);
        if (!evidence.has(eventUrl)) evidence.set(eventUrl, { url, html: $.html(card), title });
      } catch {
        /* Untrusted links are never fetched. */
      }
    });
  }
  // A date parser miss must reach extraction rather than silently disappearing. Keep it hidden
  // until a supported schedule is accepted; an API failure cannot publish an undated card.
  if (onEventPage) {
    const parsed = new Set(result.items.map((item) => item.url));
    for (const [url, card] of evidence)
      if (!parsed.has(url))
        result.items.push({
          id: eventListingId(source.id, url),
          source: source.id,
          sourceName: source.name,
          url,
          title: card.title,
          type: 'Activity',
          status: 'hidden',
          schedule: 'event',
          checkedAt,
          description: placeholderDescription(source.name),
          reviewReason: 'Event dates need verification',
          images: [],
          image: '',
        });
  }
  result.items = boundedHtmlEvents(result.items, checkedAt);
  for (const item of result.items) {
    const old = knownListings.get(item.id);
    if (item.occurrences?.length)
      item.occurrences = preserveCalendarTimes(item.occurrences, old?.occurrences);
    else if (item.schedule === 'series' && old?.occurrences?.length) {
      const window = collectionWindow(checkedAt);
      item.occurrences = old.occurrences.filter(
        (row) =>
          row.start >= (item.start > window.from ? item.start : window.from) &&
          row.end <= (item.end < window.to ? item.end : window.to),
      );
    }
  }
  const cache = storedPhotoCache(knownListings, validateUrl);
  let attempted = 0;
  for (const item of result.items) {
    let detail;
    let selector = focus[source.id];
    if (onEventPage) {
      try {
        if (++attempted > maxEventPages) throw Error('Event detail page limit reached');
        detail = pages.get(item.url) || (await fetchPage(item.url));
        if (source.id === 'park' && !load(detail)(selector).length) selector = 'main';
        result.eventPagesRead++;
      } catch (error) {
        result.eventPageFailures++;
        result.failedPages.push({ url: item.url, error: error.message });
      }
    }
    const urls = [];
    const addPhoto = (value) => {
      try {
        urls.push(validateUrl(value, 'photo'));
      } catch {}
    };
    if (item.image) addPhoto(item.image);
    if (detail) {
      const $ = load(detail);
      const main = $(selector);
      main.find('img').each((_, node) => addPhoto($(node).attr('src')));
    }
    try {
      await collectEventPhotos(item, urls, { read, storePhoto, cache });
    } catch {
      retainEventPhotos(item, knownListings.get(item.id));
      result.failedPages.push({
        url: item.url,
        error: 'Event photo enrichment failed; previous photos retained',
      });
    }
    if (detail) {
      const card = evidence.get(item.url);
      onEventPage({
        id: item.id,
        itemIds: [item.id],
        url: item.url,
        html: detail,
        selector,
        exclude: 'nav, footer, .related, .events-options-header',
        supportingPages: card ? [{ url: card.url, html: card.html }] : [],
        calendarSchedule: source.id === 'forks' && item.occurrences?.length ? 'dates' : undefined,
        dateReview: item.type === 'Activity',
        refineDateOnly: true,
      });
    }
  }
  result.reviewRequired = result.items.filter((item) => item.status === 'hidden').length;
  result.allowEmpty = !result.items.length && !result.failedPages.length;
  return result;
}
