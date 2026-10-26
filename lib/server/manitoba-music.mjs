import { load } from 'cheerio';
import { eventListingId } from '../connectors.mjs';
import {
  collectionWindow,
  validScheduleDay,
  zonedTimestamp,
  normalizeOccurrence,
} from '../event-schedule.mjs';
import {
  cleanEventText as clean,
  sourceReader,
  storedPhotoCache,
  collectEventPhotos,
  retainEventPhotos,
} from './public-event-collector.mjs';
export const MUSIC_ID = 'manitoba-music';
export const MUSIC_CALENDAR = 'https://www.manitobamusic.com/livemusic';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function musicCalendarUrl(window) {
  const [year, month, day] = window.from.split('-');
  return (
    MUSIC_CALENDAR +
    '/from:' +
    encodeURIComponent(`${MONTHS[Number(month) - 1]}+${Number(day)}+${year}`)
  );
}
export function musicUrl(value, kind = 'page') {
  const u = new URL(value, MUSIC_CALENDAR);
  const path =
    kind === 'photo'
      ? /^\/uploads\/event\/[^/]+\.(jpe?g|png|webp)$/i
      : kind === 'event'
        ? /^\/livemusic\/display,event\/\d+(?:\/[^/]+)?\/?$/
        : /^\/livemusic\/from:[A-Z][a-z]{2}(?:\+|%2B)\d{1,2}(?:\+|%2B)20\d\d(?:\/page:\d+)?\/?$/;
  if (
    u.origin !== 'https://www.manitobamusic.com' ||
    u.username ||
    u.password ||
    !path.test(u.pathname)
  )
    throw Error('Refused non-Manitoba Music source URL');
  u.hash = '';
  if (kind !== 'photo') u.search = '';
  return u.href;
}
function clock(value) {
  const match = value.match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])\.?m\.?/i);
  if (!match) return null;
  return (
    String((Number(match[1]) % 12) + (match[3].toLowerCase() === 'p' ? 12 : 0)).padStart(2, '0') +
    ':' +
    (match[2] || '00')
  );
}
export function parseMusicPage(html, expectedFrom, expectedDay) {
  const $ = load(html),
    records = [];
  if (expectedDay) {
    const [year, month, day] = expectedDay.split('-');
    if ($('#FilterFrom').attr('data-selected') !== `${month}/${day}/${year}`)
      throw Error('Manitoba Music returned a different date filter');
  }
  $('.event-item').each((_, node) => {
    const card = $(node),
      link = card.find('.event-item-title a').first(),
      url = musicUrl(link.attr('href'), 'event');
    const day = card.find('time.event-item-date').attr('datetime')?.slice(0, 10);
    if (!validScheduleDay(day)) throw Error('Manitoba Music event date is invalid');
    const lineup = card
      .find('.event-item-lineup li')
      .map((_, n) => clean($(n).text()))
      .get()
      .filter(Boolean);
    const title = clean(link.text() || link.attr('data-alt-title')) || lineup.join(' · ');
    if (!title) throw Error('Manitoba Music event title missing');
    const location = card.find('.event-item-location').first(),
      region = clean(location.find('.venue-region').first().text());
    const addressNode = location.find('.venue-address').first().clone();
    addressNode.find('.venue-region').remove();
    const address = clean(addressNode.text()).replace(/,$/, '');
    const venue = clean(location.find('.venue-name').first().text());
    const time = clean(card.find('.event-item-time').text());
    const clocks = time.match(/\b(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*[ap]\.?m\.?/gi) || [];
    const startClock = clock(time),
      endClock = clocks.length === 2 && /[-–—]/.test(time) ? clock(clocks[1]) : null;
    let end = day;
    if (startClock && endClock && endClock < startClock)
      end = new Date(Date.parse(day + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
    const photos = card
      .find('.event-item-image img')
      .map((_, n) => {
        try {
          return musicUrl($(n).attr('src'), 'photo');
        } catch {
          return null;
        }
      })
      .get();
    records.push({
      id: url.match(/display,event\/(\d+)/)[1],
      url,
      title,
      day,
      end,
      time,
      venue,
      address,
      region,
      lineup,
      photos,
      cancelled: /\b(cancelled|canceled)\b/i.test(title),
      ...(startClock
        ? {
            startAt: zonedTimestamp(day, startClock),
            endAt: zonedTimestamp(end, endClock || startClock),
          }
        : {}),
      endKnown: Boolean(endClock),
    });
  });
  const empty = /no (?:events|results)|found\s+0\s+upcoming/i.test($.text());
  if (!records.length && !empty)
    throw Error('Manitoba Music calendar layout changed or events missing');
  const links = $('a[href*="/page:"]')
    .map((_, n) => musicUrl($(n).attr('href')))
    .get();
  for (const link of links)
    if (
      decodeURIComponent(new URL(link).pathname).split('/page:')[0] !==
      decodeURIComponent(new URL(expectedFrom).pathname).replace(/\/$/, '')
    )
      throw Error('Manitoba Music pagination changed the date filter');
  const pages = links.map((u) => Number(u.match(/\/page:(\d+)/)[1]));
  return {
    records,
    empty,
    lastPage: Math.max(1, ...pages),
    advertisedTotal: Number($.text().match(/found\s+(\d+)\s+upcoming events/i)?.[1]) || null,
  };
}
export async function collectMusic(source, checkedAt = new Date().toISOString(), options = {}) {
  const { storePhoto, knownListings = new Map(), maxPages = 40 } = options,
    window = collectionWindow(checkedAt),
    base = musicCalendarUrl(window);
  const read = sourceReader({ ...options, validateUrl: musicUrl }),
    cache = storedPhotoCache(knownListings, musicUrl);
  const result = {
    items: [],
    pagesRead: 0,
    failedPages: [],
    allowEmpty: false,
    discovered: 0,
    occurrencesFound: 0,
    observedFrom: window.from,
    observedThrough: window.to,
    skippedOutsideManitoba: 0,
    locationReviewRequired: 0,
  };
  const records = new Map();
  let lastPage = 1,
    advertisedTotal = null;
  for (let page = 1; page <= Math.min(lastPage, maxPages); page++) {
    const url = page === 1 ? base : base + '/page:' + page;
    try {
      const parsed = parseMusicPage((await read(url)).toString('utf8'), base, window.from);
      result.pagesRead++;
      lastPage = Math.max(lastPage, parsed.lastPage);
      advertisedTotal ??= parsed.advertisedTotal;
      for (const record of parsed.records) {
        const key = record.id + '|' + record.day + '|' + (record.startAt || '');
        const old = records.get(key);
        if (old && (old.title !== record.title || old.endAt !== record.endAt))
          throw Error('Conflicting Manitoba Music occurrences');
        records.set(key, record);
      }
    } catch (error) {
      if (!result.pagesRead) throw error;
      result.failedPages.push({ url, error: error.message });
      break;
    }
  }
  if (lastPage > maxPages)
    result.failedPages.push({ url: base, error: 'Manitoba Music page limit reached' });
  if (!result.failedPages.length && advertisedTotal != null && records.size !== advertisedTotal)
    result.failedPages.push({
      url: base,
      error: 'Manitoba Music calendar count does not match collected records',
    });
  const groups = new Map();
  for (const e of records.values()) {
    if (e.day > window.to || e.end < window.from) continue;
    const online = /\bonline|livestream\b/i.test(e.venue + ' ' + e.region);
    const manitoba = /(?:\bMB\b|\bManitoba\b|\bWinnipeg\b)/i.test(e.region);
    const outside =
      /(?:,\s*(?:AB|BC|SK|ON|QC|NB|NS|PEI?|NL|NT|NU|YT|ND|MN|SD|NY|CA|TX|WA)\b|\b(?:Alberta|British Columbia|Saskatchewan|Ontario|Quebec|USA|United States|United Kingdom|Germany|France|Australia)\b)/i.test(
        e.region,
      );
    if (outside && !manitoba && !online) {
      result.skippedOutsideManitoba++;
      continue;
    }
    e.locationReview = !manitoba && !online;
    if (e.locationReview) result.locationReviewRequired++;
    const group = groups.get(e.id) || [];
    group.push(e);
    groups.set(e.id, group);
  }
  result.discovered = groups.size;
  for (const [identity, entries] of groups) {
    entries.sort((a, b) => (a.startAt || a.day).localeCompare(b.startAt || b.day));
    const first = entries[0],
      id = eventListingId(MUSIC_ID, MUSIC_CALENDAR + '/display,event/' + identity),
      recurring = entries.length > 1;
    const needsReview = entries.some(
      (e) => e.locationReview || e.venue !== first.venue || e.region !== first.region,
    );
    const item = {
      id,
      source: MUSIC_ID,
      sourceName: 'Manitoba Music',
      sourceIdentity: 'music:' + identity,
      checkedAt,
      title: first.title,
      url: first.url,
      eventUrl: MUSIC_CALENDAR + '/display,event/' + identity,
      type: 'Event',
      category: 'Music',
      venue: first.venue,
      address: first.address,
      neighbourhood: first.region || 'Location unconfirmed',
      description:
        (first.lineup.length ? 'Lineup: ' + first.lineup.join(', ') + '. ' : '') +
        'See the event page for tickets and details.' +
        (needsReview ? ' The source has not confirmed a Manitoba or online location.' : ''),
      price: null,
      status: needsReview ? 'hidden' : entries.every((e) => e.cancelled) ? 'cancelled' : 'active',
      ...(needsReview ? { reviewReason: 'Location needs verification' } : {}),
      recurring: recurring && !needsReview,
      schedule: recurring && !needsReview ? 'series' : 'event',
      provenance: 'calendar',
      images: [],
      image: '',
      sourceImages: [],
      occurrencesComplete: !result.failedPages.length,
      scheduleCoverage: [
        {
          ...window,
          complete: !result.failedPages.length,
          checkedAt,
          sourceUrl: base,
          basis: 'calendar',
        },
      ],
    };
    item.occurrences = entries.map((e) =>
      normalizeOccurrence(
        {
          start: e.day,
          end: e.end,
          ...(e.startAt ? { startAt: e.startAt, endAt: e.endAt } : {}),
          time: e.time,
          endTimeKnown: e.endKnown,
          url: e.url,
          basis: 'calendar',
          cancelled: e.cancelled,
          ...(e.title !== first.title ? { sourceOverrides: { title: e.title } } : {}),
        },
        item,
      ),
    );
    if (!recurring) Object.assign(item, { start: first.day, end: first.end, time: first.time });
    try {
      await collectEventPhotos(
        item,
        entries.flatMap((e) => e.photos),
        { read, storePhoto, cache },
      );
    } catch {
      retainEventPhotos(item, knownListings.get(id));
      result.failedPages.push({
        url: item.url,
        error: 'Manitoba Music photo enrichment failed; previous photos retained',
      });
    }
    result.occurrencesFound += item.occurrences.length;
    result.items.push(item);
  }
  result.reviewRequired = result.items.filter((e) => e.status === 'hidden').length;
  result.allowEmpty = !result.failedPages.length && !result.items.length;
  return result;
}
