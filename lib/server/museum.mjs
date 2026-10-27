import { parseTribeMonth, tribeTimestamp as museumTimestamp } from './tribe-calendar.mjs';
// Manitoba Museum month calendars: separate recurring sessions and verified exhibition runs.
import { load } from 'cheerio';
import { setTimeout as pause } from 'node:timers/promises';
import { eventListingId, occurrenceListingId, localDay, summarize } from '../connectors.mjs';
import { readLimited } from './request-body.mjs';

export const MUSEUM_ID = 'manitoba-museum';
export const MUSEUM_CALENDAR = 'https://manitobamuseum.ca/whats-on/';
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const clean = (value) =>
  load(load(String(value || '').replace(/\\n/g, ' ')).text())
    .text()
    .replace(/\s+/g, ' ')
    .trim();
const validDay = (value) =>
  /^20\d\d-\d\d-\d\d$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;

export function museumUrl(value, kind = 'event') {
  const url = new URL(value, MUSEUM_CALENDAR);
  const allowed =
    kind === 'photo'
      ? /^\/wp-content\/uploads\/.+\.(jpe?g|png|webp)$/i
      : kind === 'month'
        ? /^\/whats-on\/month\/20\d\d-(0[1-9]|1[0-2])\/$/
        : /^\/event\/[^/]+\/(?:20\d\d-\d\d-\d\d\/(?:\d+\/)?)?$/;
  if (
    url.origin !== 'https://manitobamuseum.ca' ||
    url.username ||
    url.password ||
    !allowed.test(url.pathname)
  )
    throw Error('Refused non-Museum source URL');
  url.search = '';
  url.hash = '';
  return url.href;
}
const groupKey = (url) =>
  new URL(museumUrl(url)).pathname.replace(/\/20\d\d-\d\d-\d\d\/(?:\d+\/)?$/, '/');
const wallDay = (iso) => {
  if (validDay(iso || '')) return iso;
  if (
    typeof iso !== 'string' ||
    !/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/.test(iso) ||
    !Number.isFinite(Date.parse(iso)) ||
    !validDay(iso.slice(0, 10))
  )
    throw Error('Museum occurrence date is invalid');
  return localDay(new Date(iso));
};

/** Museum calendar offsets can reflect the cached page's DST rather than the session date.
 * Its displayed wall times are Winnipeg local time; retain UTC values as explicit instants.
 */
export { tribeTimestamp as museumTimestamp } from './tribe-calendar.mjs';

export const parseMuseumMonth = (html, expectedMonth) =>
  parseTribeMonth(html, expectedMonth, {
    label: 'Museum',
    url: museumUrl,
    timestamp: museumTimestamp,
    groupKey,
  });

/** Only explicit overall-run language establishes bounds; daily Event dates do not. */
export function parseMuseumRun(text) {
  text = clean(text);
  const result = {};
  const month = '(' + MONTHS.join('|') + ')';
  const range = text.match(
    new RegExp(
      '\\b(?:runs? (?:from )?|on display (?:from )?|exhibition dates: ?)' +
        month +
        '\\s+(\\d{1,2})(?:,?\\s+(20\\d{2}))?\\s*(?:–|—|-|to|through)\\s*' +
        month +
        '\\s+(\\d{1,2}),?\\s+(20\\d{2})\\b',
      'i',
    ),
  );
  if (range) {
    let firstYear = Number(range[3] || range[6]);
    const firstMonth = MONTHS.indexOf(range[1].toLowerCase()) + 1;
    const lastMonth = MONTHS.indexOf(range[4].toLowerCase()) + 1;
    if (!range[3] && firstMonth > lastMonth) firstYear--;
    result.start = `${firstYear}-${String(firstMonth).padStart(2, '0')}-${range[2].padStart(2, '0')}`;
    result.end = `${range[6]}-${String(lastMonth).padStart(2, '0')}-${range[5].padStart(2, '0')}`;
    if (!validDay(result.start) || !validDay(result.end))
      throw Error('Museum overall range invalid');
  }
  const opening = text.match(
    new RegExp(
      '\\b(?:opened|opens|opening(?: on)?|on display from|runs? from)\\s+' +
        month +
        '\\s+(\\d{1,2}),?\\s+(20\\d{2})\\b',
      'i',
    ),
  );
  if (opening) {
    const value = `${opening[3]}-${String(MONTHS.indexOf(opening[1].toLowerCase()) + 1).padStart(2, '0')}-${opening[2].padStart(2, '0')}`;
    if (!validDay(value)) throw Error('Museum overall opening date invalid');
    result.start = value;
  }
  const closing = text.match(
    new RegExp(
      '\\b(?:on display[\\s\\S]{0,160}?until|exhibition[\\s\\S]{0,100}?closes(?: on)?|runs?[\\s\\S]{0,100}?(?:until|through)|closing(?: date)?(?: is|:| on)?)\\s+' +
        month +
        '(?:\\s+(\\d{1,2})(?!\\d))?,?\\s+(20\\d{2})\\b',
      'i',
    ),
  );
  if (closing) {
    const value = `${closing[3]}-${String(MONTHS.indexOf(closing[1].toLowerCase()) + 1).padStart(2, '0')}`;
    if (closing[2]) {
      const end = value + '-' + closing[2].padStart(2, '0');
      if (!validDay(end)) throw Error('Museum overall closing date invalid');
      result.end = end;
    } else result.endMonth = value;
  }
  if (
    result.start &&
    (result.end || result.endMonth) &&
    result.start.slice(0, result.end ? 10 : 7) > (result.end || result.endMonth)
  )
    throw Error('Museum overall run dates disagree');
  return result;
}

function museumImages(entry) {
  const images = [];
  const imageKeys = new Set();
  const add = (value) => {
    if (!value || images.length === 3) return;
    try {
      const url = museumUrl(value, 'photo');
      const key = new URL(url).pathname.replace(/(?:-\d+x\d+|-scaled)+(?=\.[^.]+$)/i, '');
      if (!/logo|sponsor|headshot|icon|partner/i.test(url) && !imageKeys.has(key)) {
        imageKeys.add(key);
        images.push(url);
      }
    } catch {}
  };
  for (const image of [].concat(entry.image || []))
    add(typeof image === 'string' ? image : image?.contentUrl || image?.url);
  return images;
}

export function parseMuseumDetail(html, entry) {
  const $ = load(html);
  const seriesRuns = [];
  $('script[type="application/ld+json"]').each((_, node) => {
    let data;
    try {
      data = JSON.parse($(node).text());
    } catch {
      return;
    }
    for (const e of Array.isArray(data) ? data : [data, ...(data?.['@graph'] || [])]) {
      const candidates = [e, ...(e?.superEvent ? [e.superEvent] : [])];
      for (const series of candidates) {
        if (series?.['@type'] !== 'EventSeries' || !series.url) continue;
        try {
          if (
            groupKey(series.url) !== entry.groupKey &&
            groupKey(series.url) !== groupKey(entry.url)
          )
            continue;
        } catch {
          continue;
        }
        const run = {};
        if (series.startDate) run.start = wallDay(series.startDate);
        if (series.endDate) run.end = wallDay(series.endDate);
        if (run.start && run.end && run.end < run.start)
          throw Error('Museum series dates disagree');
        seriesRuns.push(run);
      }
    }
  });
  $('script,style,template,nav,header,footer').remove();
  const description = $('.tribe-events-single-event-description').first();
  if (!$('#tribe-events-content').length || !description.length || !$('h1').length)
    throw Error('Museum event detail layout changed');
  description.find('script,style,.sponsor,.sponsors').remove();
  const text = clean(description.html());
  const run = parseMuseumRun(text);
  for (const candidate of seriesRuns) {
    if (
      (run.start && candidate.start && run.start !== candidate.start) ||
      (run.end && candidate.end && run.end !== candidate.end) ||
      (run.endMonth && candidate.end && run.endMonth !== candidate.end.slice(0, 7))
    )
      throw Error('Museum overall and series dates disagree');
    Object.assign(run, candidate);
    if (candidate.end) delete run.endMonth;
  }
  const categories = $('.tribe-events-event-categories').text();
  const images = museumImages(entry);
  return {
    cancelled: /\bthis (?:event|exhibition) (?:is|has been) cancelled\b/i.test(text),
    seriesCancelled:
      /\b(?:this (?:program|series|exhibition)|all (?:sessions|occurrences|performances)) (?:are|is|have been|has been) cancelled\b/i.test(
        text,
      ),
    description: summarize(text),
    run,
    images,
    exhibition: /exhibition/i.test(categories),
    recurring: /\b(?:every|monthly|weekly|recurring|Sundays|Saturdays|Fridays)\b/i.test(text),
    online: /\blivestream|online event\b/i.test(text),
  };
}

function makeListing(group, detail, checkedAt, previous, occurrence = false) {
  const first = group[0];
  const title = clean(first.name);
  const datedIdentity = /\/20\d\d-\d\d-\d\d\//.test(new URL(first.url).pathname);
  const series =
    !occurrence && (datedIdentity || group.length > 1 || detail.exhibition || detail.recurring);
  const seriesId = eventListingId(MUSEUM_ID, 'https://manitobamuseum.ca' + first.groupKey);
  const id = occurrence
    ? occurrenceListingId(MUSEUM_ID, 'https://manitobamuseum.ca' + first.groupKey, first.startDate)
    : seriesId;
  const observedFrom = group.map((e) => e.startDay).sort()[0];
  const observedThrough = group
    .map((e) => e.endDay)
    .sort()
    .at(-1);
  let run = { ...detail.run };
  // A partial later calendar or stripped detail must not erase a previously verified run.
  if (
    previous?.title === title &&
    previous.runDates &&
    observedFrom <=
      (previous.runDates.end ||
        (previous.runDates.endMonth ? previous.runDates.endMonth + '-31' : '9999-12-31')) &&
    (!run.start || !previous.runDates.start || run.start === previous.runDates.start)
  ) {
    run = { ...previous.runDates, ...run };
    if (detail.run.end) delete run.endMonth;
    else if (detail.run.endMonth) delete run.end;
  }
  if (!series) run = { start: first.startDay, end: first.endDay };
  const location = first.location || {};
  const online = detail.online;
  const place = clean(location.name) || 'Manitoba Museum';
  const offers = Array.isArray(first.offers) ? first.offers : [first.offers];
  const prices = offers
    .filter((o) => o?.price != null && String(o.price).trim() !== '')
    .map((o) => Number(o.price))
    .filter((p) => Number.isFinite(p) && p >= 0);
  const time =
    !series && first.startDate.includes('T')
      ? new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Winnipeg',
          hour: 'numeric',
          minute: '2-digit',
        }).format(new Date(first.startDate)) +
        ' – ' +
        new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Winnipeg',
          hour: 'numeric',
          minute: '2-digit',
        }).format(new Date(first.endDate || first.startDate))
      : '';
  return {
    id,
    source: MUSEUM_ID,
    sourceName: 'Manitoba Museum',
    checkedAt,
    ...(occurrence
      ? {
          recurring: true,
          seriesId,
          startAt: first.startDate,
          endAt: first.endDate || first.startDate,
        }
      : {}),
    title,
    url: first.url,
    type: series ? 'Activity' : 'Event',
    category: 'Arts & culture',
    venue: online ? 'Online' : place,
    address: online ? '' : clean(location.address?.streetAddress) || '190 Rupert Avenue, Winnipeg',
    neighbourhood: online ? 'Online' : 'Downtown',
    ...run,
    ...(Object.keys(detail.run).length || previous?.runDates ? { runDates: run } : {}),
    ...(series ? { observedFrom, observedThrough } : {}),
    time,
    schedule: series ? 'series' : 'event',
    price: prices.length === 1 ? prices[0] : null,
    family: /family|families|children|kids/i.test(detail.description),
    indoor: true,
    status:
      detail.cancelled || (!series && /EventCancelled$/.test(first.eventStatus || ''))
        ? 'cancelled'
        : 'active',
    description: detail.description,
    image: detail.images[0] || '',
    images: detail.images,
    sourceImages: detail.images,
    occurrenceSamples: group.slice(0, 200).map((e) => ({
      url: e.url,
      start: e.startDate,
      end: e.endDate || e.startDate,
      cancelled: /EventCancelled$/.test(e.eventStatus || ''),
      ...(e.publishedStartDate !== e.startDate ? { publishedStart: e.publishedStartDate } : {}),
      ...(e.publishedEndDate !== (e.endDate || e.startDate)
        ? { publishedEnd: e.publishedEndDate }
        : {}),
    })),
  };
}

export async function collectMuseum(
  source,
  checkedAt = new Date().toISOString(),
  {
    fetchImpl = fetch,
    storePhoto,
    knownListings = new Map(),
    pauseMs = 20000,
    maxGroups = 20,
    maxRunMs = 540000,
    signal = AbortSignal.timeout(maxRunMs),
  } = {},
) {
  let last = 0;
  const read = async (url, kind) => {
    url = museumUrl(url, kind);
    const initial = url;
    for (let hop = 0; hop < 3; hop++) {
      signal.throwIfAborted();
      await pause(Math.max(0, last + pauseMs - Date.now()), undefined, { signal });
      last = Date.now();
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': 'Winnigo/1.0 (Museum public event collection)' },
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw Error('Museum redirect has no destination');
        const next = museumUrl(new URL(location, url).href, kind);
        if (kind === 'event' && groupKey(next) !== groupKey(initial))
          throw Error('Museum event redirected to a different series');
        if (hop === 2) throw Error('Museum redirect limit reached');
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw Error('Source returned HTTP ' + response.status);
      }
      const bytes = await readLimited(
        response.body,
        kind === 'photo' ? 8 * 1024 * 1024 : 2_000_000,
      );
      if (!bytes) throw Error('Museum response exceeds size limit');
      return bytes;
    }
  };
  const today = localDay(new Date(checkedAt));
  const month = today.slice(0, 7);
  const next = new Date(month + '-01T12:00:00Z');
  next.setUTCMonth(next.getUTCMonth() + 1);
  const months = [month, next.toISOString().slice(0, 7)];
  const horizon = new Date(months[1] + '-01T12:00:00Z');
  horizon.setUTCMonth(horizon.getUTCMonth() + 1);
  horizon.setUTCDate(0);
  const until = horizon.toISOString().slice(0, 10);
  const result = {
    items: [],
    pagesRead: 0,
    eventPagesRead: 0,
    eventPageFailures: 0,
    failedPages: [],
    allowEmpty: false,
    discovered: 0,
    occurrencesFound: 0,
    observedFrom: month + '-01',
    supersededIds: [],
    observedThrough: until,
  };
  const occurrences = new Map();
  for (const m of months) {
    const url = new URL(`month/${m}/`, source.url).href;
    try {
      const parsed = parseMuseumMonth(Buffer.from(await read(url, 'month')).toString('utf8'), m);
      result.pagesRead++;
      for (const e of parsed.events)
        if (e.startDay <= until && e.endDay >= result.observedFrom)
          occurrences.set(e.groupKey + '|' + new Date(e.startDate).toISOString(), e);
    } catch (error) {
      if (!result.pagesRead) throw error;
      result.failedPages.push({ url, error: error.message });
    }
  }
  const groups = new Map();
  for (const e of occurrences.values()) {
    const list = groups.get(e.groupKey) || [];
    list.push(e);
    groups.set(e.groupKey, list);
  }
  result.occurrencesFound = occurrences.size;
  result.discovered = groups.size;
  const storedImages = new Map();
  let attempted = 0;
  for (const [key, members] of groups) {
    const sorted = [...members].sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate));
    const representative =
      sorted.find((e) => Date.parse(e.endDate || e.startDate) >= Date.parse(checkedAt)) ||
      sorted[0];
    const group = [representative, ...sorted.filter((e) => e !== representative)];
    const entry = group[0];
    if (attempted >= maxGroups || signal.aborted) {
      result.failedPages.push({ url: entry.url, error: 'Museum collection limit reached' });
      break;
    }
    let photoStage = false;
    try {
      attempted++;
      // The calendar is sufficient for explicitly once-only events; their URL may redirect
      // to a promotional/booking page outside the Museum event-detail template.
      let detail;
      if (
        group.length === 1 &&
        entry.url === 'https://manitobamuseum.ca' + key &&
        /\bfor one (?:night|day) only\b/i.test(clean(entry.description))
      ) {
        detail = {
          description: summarize(clean(entry.description)),
          run: {},
          images: museumImages(entry),
          exhibition: false,
          recurring: false,
          online: false,
          cancelled: false,
        };
      } else {
        detail = parseMuseumDetail(
          Buffer.from(await read(entry.url, 'event')).toString('utf8'),
          entry,
        );
        result.eventPagesRead++;
      }
      const id = eventListingId(MUSEUM_ID, 'https://manitobamuseum.ca' + key);
      const previous = knownListings.get(id);
      const item = makeListing(group, detail, checkedAt, previous);
      if (
        (item.end && item.observedFrom > item.end) ||
        (item.endMonth && item.observedFrom.slice(0, 7) > item.endMonth) ||
        (item.start && item.observedFrom && item.observedFrom < item.start)
      )
        throw Error('Museum occurrence is outside the published overall run');
      const split =
        item.schedule === 'series' &&
        !detail.exhibition &&
        !(previous?.runDates && !detail.recurring);
      const items = split
        ? sorted.map((entry) =>
            makeListing(
              [entry],
              {
                ...detail,
                run: {},
                cancelled: detail.seriesCancelled || (entry === representative && detail.cancelled),
                images: museumImages(entry).length ? museumImages(entry) : detail.images,
              },
              checkedAt,
              undefined,
              true,
            ),
          )
        : [item];
      for (const candidate of items) {
        if (storePhoto) {
          photoStage = true;
          const images = [];
          const saved = knownListings.get(candidate.id) || previous;
          for (const url of candidate.sourceImages) {
            let stored = storedImages.get(url);
            const oldIndex = saved?.sourceImages?.indexOf(url) ?? -1;
            if (
              !stored &&
              oldIndex >= 0 &&
              /^\/api\/photos\/[a-f0-9]{64}$/.test(saved.images?.[oldIndex] || '')
            )
              stored = saved.images[oldIndex];
            if (!stored) {
              const bytes = Buffer.from(await read(url, 'photo'));
              const contentType =
                bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
                  ? 'image/jpeg'
                  : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
                    ? 'image/png'
                    : bytes.toString('ascii', 0, 4) === 'RIFF' &&
                        bytes.toString('ascii', 8, 12) === 'WEBP'
                      ? 'image/webp'
                      : null;
              if (!contentType) throw Error('Museum photo is not a supported image');
              stored = await storePhoto({ bytes, contentType });
              storedImages.set(url, stored);
            }
            images.push(stored);
          }
          candidate.images = images;
          candidate.image = images[0] || '';
        }
      }
      result.items.push(...items);
      // Offset corrections replace the prior session, without retiring another actual showtime.
      for (const candidate of items.filter((item) => item.recurring))
        for (const old of knownListings.values())
          if (
            old.recurring &&
            old.seriesId === candidate.seriesId &&
            old.id !== candidate.id &&
            old.startAt?.slice(0, 19) === candidate.startAt.slice(0, 19) &&
            museumTimestamp(old.startAt) === candidate.startAt
          )
            result.supersededIds.push(old.id);
      if (split && previous && !previous.recurring) result.supersededIds.push(previous.id);
    } catch (error) {
      result.eventPageFailures++;
      result.failedPages.push({
        url: entry.url,
        error: photoStage
          ? 'Museum event photos unavailable; prior listing retained'
          : error.message,
      });
    }
  }
  for (const item of result.items) {
    item.scheduleCoverage = [
      {
        from: result.observedFrom,
        to: result.observedThrough,
        complete: result.pagesRead === months.length,
        checkedAt,
        sourceUrl: source.url,
      },
    ];
  }
  result.allowEmpty = !result.failedPages.length && occurrences.size === 0;
  return result;
}
