// FortWhyte's default ICS export is incomplete; collect explicit month occurrences instead.
import { load } from 'cheerio';
import { setTimeout as pause } from 'node:timers/promises';
import { eventListingId, summarize } from '../connectors.mjs';
import { collectionWindow, normalizeOccurrence } from '../event-schedule.mjs';
import { parseTribeMonth, tribeTimestamp } from './tribe-calendar.mjs';
import { readLimited } from './request-body.mjs';
export const FORTWHYTE_ID = 'fortwhyte';
export const FORTWHYTE_CALENDAR = 'https://www.fortwhyte.org/events/';
const clean = (v) =>
  load(load(String(v || '').replace(/\\n/g, ' ')).text())
    .text()
    .replace(/\s+/g, ' ')
    .trim();
let lastRequestAt = 0;
const mergeEntry = (a, b) => ({
  ...a,
  ...b,
  image: b.image || a.image,
  description: b.description || a.description,
  location: b.location || a.location,
  offers: b.offers || a.offers,
});
const PRIVATE_PHOTO = /^\/api\/photos\/[a-f0-9]{64}$/;
export function fortwhyteUrl(value, kind = 'event') {
  const url = new URL(value, FORTWHYTE_CALENDAR);
  const path =
    kind === 'photo'
      ? /^\/wp-content\/uploads\/.+\.(png|jpe?g|webp)$/i
      : kind === 'month'
        ? /^\/events\/month\/20\d\d-(0[1-9]|1[0-2])\/$/
        : /^\/event\/[^/]+\/(?:20\d\d-\d\d-\d\d\/(?:\d+\/)?)?$/;
  if (
    url.origin !== 'https://www.fortwhyte.org' ||
    url.username ||
    url.password ||
    !path.test(url.pathname)
  )
    throw Error('Refused non-FortWhyte source URL');
  url.search = '';
  url.hash = '';
  return url.href;
}
const seriesUrl = (url) => fortwhyteUrl(url).replace(/\/20\d\d-\d\d-\d\d\/(?:\d+\/)?$/, '/');
export function parseFortwhyteMonth(html, month) {
  const parsed = parseTribeMonth(html, month, {
    label: 'FortWhyte',
    url: fortwhyteUrl,
    groupKey: seriesUrl,
    // Tribe caches the current DST offset even for winter dates. Published wall times are local.
    timestamp: tribeTimestamp,
  });
  // Overflow links hide events visually; require JSON-LD to cover the grid's advertised counts.
  const records = new Map();
  for (const event of parsed.events) {
    const key = event.url + '|' + event.startDate,
      previous = records.get(key);
    if (
      previous &&
      (previous.endDate !== event.endDate || clean(previous.name) !== clean(event.name))
    )
      throw Error('FortWhyte duplicate occurrence data disagree');
    records.set(key, previous ? mergeEntry(previous, event) : event);
  }
  const unique = [...records.values()];
  for (const day of Object.values(parsed.viewData?.days || {})) {
    if (day.date?.slice(0, 7) !== month) continue;
    const count = unique.filter((e) => e.startDay <= day.date && e.endDay >= day.date).length;
    if (Number(day.found_events) > count)
      throw Error('FortWhyte month omits advertised occurrences');
  }
  if (parsed.next) {
    const next = new Date(month + '-01T12:00:00Z');
    next.setUTCMonth(next.getUTCMonth() + 1);
    if (parsed.next !== FORTWHYTE_CALENDAR + 'month/' + next.toISOString().slice(0, 7) + '/')
      throw Error('FortWhyte next-month navigation disagrees');
  }
  return { ...parsed, events: unique };
}
function photoUrls(event) {
  const values = Array.isArray(event.image) ? event.image : [event.image];
  return [
    ...new Set(
      values
        .filter(Boolean)
        .map((i) => fortwhyteUrl(typeof i === 'string' ? i : i.contentUrl || i.url, 'photo')),
    ),
  ].slice(0, 3);
}
/** Images must belong to the requested event, inside its content rather than site chrome. */
export function parseFortwhyteDetailPhotos(html, expectedUrl) {
  const $ = load(html),
    content = $('#tribe-events-content');
  if (
    !content.length ||
    !content.find('.tribe-events-single-event-title').text().trim() ||
    !content.find('.tribe-events-single-event-description').length
  )
    throw Error('FortWhyte event detail layout changed');
  const expected = seriesUrl(expectedUrl),
    events = [];
  $('script[type="application/ld+json"]').each((_, node) => {
    const data = JSON.parse($(node).text());
    events.push(
      ...(Array.isArray(data) ? data : [data, ...(data?.['@graph'] || [])]).filter(
        (e) => e?.['@type'] === 'Event' || e?.['@type']?.includes?.('Event'),
      ),
    );
  });
  const event = events.find((e) => seriesUrl(e.url) === expected);
  if (!event) throw Error('FortWhyte detail belongs to a different event');
  const images = photoUrls(event);
  content.find('.sponsor,.sponsors,header,footer,nav,script,style').remove();
  content
    .find('.tribe-events-single-event-description img, .tribe-events-event-image img')
    .each((_, node) => {
      const img = $(node),
        link = img.closest('a').attr('href');
      const value =
        link && /\.(jpe?g|png|webp)(?:[?#]|$)/i.test(link)
          ? link
          : img.attr('data-src') || img.attr('src');
      if (value) images.push(fortwhyteUrl(value, 'photo'));
    });
  return [...new Set(images)].slice(0, 3);
}

function retainPhotos(item, old) {
  const saved = (old?.images || [])
    .map((image, i) => [image, old.sourceImages?.[i]])
    .filter(([image]) => PRIVATE_PHOTO.test(image))
    .slice(0, 3);
  item.images = saved.map(([image]) => image);
  item.sourceImages = saved.map(([, url]) => url);
  item.image = item.images[0] || '';
}
function photoType(bytes) {
  return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    ? 'image/jpeg'
    : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'image/png'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
        ? 'image/webp'
        : null;
}
export async function collectFortwhyte(
  source,
  checkedAt = new Date().toISOString(),
  {
    fetchImpl = fetch,
    storePhoto,
    knownListings = new Map(),
    enrichDetails = Boolean(storePhoto),
    pauseMs = 60000,
    maxRequests = 26,
    maxRunMs = 1680000,
    signal = AbortSignal.timeout(maxRunMs),
  } = {},
) {
  let requests = 0;
  const read = async (value, kind) => {
    const url = fortwhyteUrl(value, kind);
    signal.throwIfAborted();
    if (requests >= maxRequests) throw Error('FortWhyte request limit reached');
    await pause(Math.max(0, lastRequestAt + pauseMs - Date.now()), undefined, { signal });
    signal.throwIfAborted();
    lastRequestAt = Date.now();
    requests++;
    const response = await fetchImpl(url, {
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      headers: { 'User-Agent': 'Winnigo/1.0 (FortWhyte public event collection)' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error('Source returned HTTP ' + response.status);
    }
    const bytes = await readLimited(response.body, kind === 'photo' ? 8 * 1024 * 1024 : 2_000_000);
    if (!bytes?.length) throw Error('Empty or oversized FortWhyte response');
    return Buffer.from(bytes);
  };
  const window = collectionWindow(checkedAt);
  const months = [window.from.slice(0, 7), window.to.slice(0, 7)];
  const result = {
    items: [],
    pagesRead: 0,
    eventPagesRead: 0,
    eventPageFailures: 0,
    failedPages: [],
    allowEmpty: false,
    discovered: 0,
    occurrencesFound: 0,
    observedFrom: window.from,
    observedThrough: window.to,
  };
  const occurrences = new Map();
  let firstFailure;
  for (const month of months) {
    const url = FORTWHYTE_CALENDAR + 'month/' + month + '/';
    try {
      const parsed = parseFortwhyteMonth((await read(url, 'month')).toString('utf8'), month);
      result.pagesRead++;
      for (const e of parsed.events)
        if (e.startDay <= window.to && e.endDay >= window.from) {
          const key = e.url + '|' + e.startDate;
          const prior = occurrences.get(key);
          if (prior && (prior.endDate !== e.endDate || clean(prior.name) !== clean(e.name)))
            throw Error('FortWhyte overlapping month data disagree');
          occurrences.set(key, prior ? mergeEntry(prior, e) : e);
        }
    } catch (error) {
      firstFailure ??= error;
      result.failedPages.push({ url, error: error.message });
    }
  }
  if (!result.pagesRead) throw firstFailure;
  const complete = !result.failedPages.length,
    groups = new Map();
  for (const e of occurrences.values()) {
    const members = groups.get(e.groupKey) || [];
    members.push(e);
    groups.set(e.groupKey, members);
  }
  const cache = new Map();
  result.occurrencesFound = occurrences.size;
  result.discovered = groups.size;
  for (const [url, entries] of groups) {
    entries.sort((a, b) => a.startDate.localeCompare(b.startDate));
    const first = entries[0],
      id = eventListingId(FORTWHYTE_ID, url),
      old = knownListings.get(id);
    const recurring = entries.length > 1 || entries.some((e) => e.url !== url);
    const location = first.location || {};
    const offers = Array.isArray(first.offers) ? first.offers : [first.offers];
    const prices = offers
      .filter(
        (o) =>
          o?.price != null &&
          String(o.price).trim() !== '' &&
          (!o.priceCurrency || o.priceCurrency === 'CAD'),
      )
      .map((o) => Number(o.price))
      .filter((p) => Number.isFinite(p) && p >= 0);
    const item = {
      id,
      source: FORTWHYTE_ID,
      sourceName: 'FortWhyte Alive',
      sourceIdentity: url,
      checkedAt,
      title: clean(first.name),
      url,
      eventUrl: url,
      type: 'Event',
      category: 'Experiences',
      venue: clean(location.name) || 'FortWhyte Alive',
      address: clean(location.address?.streetAddress),
      neighbourhood: 'Winnipeg',
      description:
        summarize(clean(first.description)) || 'See the FortWhyte event page for details.',
      price: prices.length === 1 ? prices[0] : null,
      recurring,
      schedule: recurring ? 'series' : 'event',
      status: entries.every((e) => /EventCancelled$/.test(e.eventStatus || ''))
        ? 'cancelled'
        : 'active',
      provenance: 'calendar',
      images: [],
      image: '',
      sourceImages: [],
      occurrences: [],
      occurrencesComplete: complete,
      scheduleCoverage: [
        { ...window, complete, checkedAt, sourceUrl: FORTWHYTE_CALENDAR, basis: 'calendar' },
      ],
    };
    item.occurrences = entries.map((e) =>
      normalizeOccurrence(
        {
          start: e.startDay,
          end: e.endDay,
          ...(e.startDate.includes('T') ? { startAt: e.startDate, endAt: e.endDate } : {}),
          publishedStart: e.publishedStartDate,
          publishedEnd: e.publishedEndDate,
          ...(e.endDateKnown === false ? { endTimeKnown: false } : {}),
          url: e.url,
          cancelled: /EventCancelled$/.test(e.eventStatus || ''),
          basis: 'calendar',
          sourceOverrides: {
            ...(clean(e.name) !== item.title ? { title: clean(e.name) } : {}),
            ...(clean(e.description) && summarize(clean(e.description)) !== item.description
              ? { description: summarize(clean(e.description)) }
              : {}),
            ...(clean(e.location?.name) && clean(e.location.name) !== item.venue
              ? { venue: clean(e.location.name) }
              : {}),
          },
        },
        item,
      ),
    );
    if (!recurring)
      Object.assign(item, {
        start: first.startDay,
        end: first.endDay,
        time: item.occurrences[0].time,
      });
    let detailStage = false;
    try {
      item.sourceImages = [...new Set(entries.flatMap(photoUrls))].slice(0, 3);
      if (!item.sourceImages.length && enrichDetails) {
        const age = Date.parse(checkedAt) - Date.parse(old?.photoPage?.checkedAt || '');
        if (
          age >= 0 &&
          age < 7 * 86400000 &&
          seriesUrl(old.photoPage.url) === url &&
          Array.isArray(old.sourceImages)
        ) {
          item.sourceImages = old.sourceImages.map((u) => fortwhyteUrl(u, 'photo')).slice(0, 3);
          item.photoPage = old.photoPage;
        } else {
          detailStage = true;
          const representative =
            entries.find(
              (e) =>
                Date.parse(e.endDate) >= Date.parse(checkedAt) &&
                !/EventCancelled$/.test(e.eventStatus || ''),
            ) || first;
          const html = (await read(representative.url, 'event')).toString('utf8');
          result.eventPagesRead++;
          item.sourceImages = parseFortwhyteDetailPhotos(html, representative.url);
          item.photoPage = { url: representative.url, checkedAt };
          detailStage = false;
        }
      }
      if (!complete && !item.sourceImages.length && old?.images?.length) {
        retainPhotos(item, old);
      } else if (storePhoto) {
        for (const image of item.sourceImages) {
          let stored = cache.get(image);
          const index = old?.sourceImages?.indexOf(image) ?? -1;
          if (!stored && index >= 0 && PRIVATE_PHOTO.test(old.images?.[index] || ''))
            stored = old.images[index];
          if (!stored) {
            const bytes = await read(image, 'photo'),
              contentType = photoType(bytes);
            if (!contentType) throw Error('FortWhyte photo is not a supported image');
            stored = await storePhoto({ bytes, contentType });
          }
          if (!PRIVATE_PHOTO.test(stored)) throw Error('Invalid stored FortWhyte photo');
          cache.set(image, stored);
          item.images.push(stored);
        }
        item.image = item.images[0] || '';
      }
    } catch {
      if (detailStage) result.eventPageFailures++;
      retainPhotos(item, old);
      if (old?.photoPage) item.photoPage = old.photoPage;
      result.failedPages.push({
        url: entries[0].url,
        error: detailStage
          ? 'FortWhyte detail photos unavailable; previous photos retained'
          : 'FortWhyte photo enrichment failed; previous photos retained',
      });
    }
    result.items.push(item);
  }
  result.allowEmpty = !result.failedPages.length && !result.items.length;
  return result;
}
