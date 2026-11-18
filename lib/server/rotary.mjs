// Rotary Club of Winnipeg (a ClubRunner site). The home page "Upcoming Events" box lists the
// club's public events; each event's page gives its date, place, description and a small poster.
// When the home page shows a full-size poster whose QR code leads to that event's registration
// page (same title and date), the full poster, ticket link and door/start times are added.
import jsQR from 'jsqr';
import { collectionWindow, validScheduleDay } from '../event-schedule.mjs';
import { readLimited } from './request-body.mjs';
import { boundedHtmlEvents } from './html-events.mjs';
import {
  collectEventPhotos,
  storedPhotoCache,
  retainEventPhotos,
} from './public-event-collector.mjs';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import {
  categoryFor,
  clean,
  eventListingId,
  placeholderDescription,
  summarize,
} from '../connectors.mjs';

export const ROTARY_SOURCE_ID = 'winnipeg-rotary';
export const ROTARY_CALENDAR = 'https://winnipegrotary.org/998/CalendarFeed/GetCalendarItemsPortal';

// Only these hosts are ever requested, including when following redirects from a QR code.
const ALLOWED_HOSTS = new Set([
  'winnipegrotary.org',
  'portal.clubrunner.ca',
  'clubrunner.blob.core.windows.net',
  'www.crsadmin.com',
  'crsadmin.com',
  'www.canvaqr.com',
  'canvaqr.com',
]);
const USER_AGENT = 'Winnigo/1.0 (Winnipeg discovery; source-attributed listings)';
const MAX_HTML_BYTES = 2_000_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_POSTER_CANDIDATES = 4;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * GET with redirects followed by hand (at most four hops), refusing any host outside
 * ALLOWED_HOSTS. Returns the final URL and the body (text, or bytes when `binary`).
 */
export async function fetchAllowed(url, { binary = false, json } = {}) {
  let current = new URL(url);
  for (let hop = 0; hop < 5; hop++) {
    if (current.protocol !== 'https:' || !ALLOWED_HOSTS.has(current.hostname))
      throw Error('Refused host ' + current.hostname);
    if (json && current.href !== ROTARY_CALENDAR) throw Error('Refused calendar request URL');
    const response = await fetch(current, {
      redirect: 'manual',
      ...(json ? { method: 'POST', body: JSON.stringify(json) } : {}),
      headers: {
        'User-Agent': USER_AGENT,
        ...(json ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status >= 300 && response.status < 400) {
      if (json) throw Error('Refused calendar redirect');
      const location = response.headers.get('location');
      if (!location) throw Error('Redirect without location');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw Error('Source returned HTTP ' + response.status);
    const limit = binary ? MAX_IMAGE_BYTES : MAX_HTML_BYTES;
    const body = await readLimited(response.body, limit);
    if (!body?.length) throw Error('Unexpected source size');
    return { url: current.href, body: binary ? body : new TextDecoder().decode(body) };
  }
  throw Error('Too many redirects');
}

/** ClubRunner's public calendar replaces the retired home-page box. Ignore speaker/member
 * entries; only own club event links with valid dates enter the public event collector. */
export function parseRotaryCalendar(body, window) {
  const value = JSON.parse(body);
  if (
    !Array.isArray(value.Events) ||
    value.Events.length > 1000 ||
    value.From?.slice(0, 10) !== window.from ||
    value.To?.slice(0, 10) !== window.until
  )
    throw Error('Rotary calendar response does not match the requested date window');
  return value.Events.flatMap((event) => {
    let url;
    try {
      url = new URL(event.Url, 'https://winnipegrotary.org/');
    } catch {
      return [];
    }
    if (
      url.username ||
      url.password ||
      url.protocol !== 'https:' ||
      !(
        (url.hostname === 'portal.clubrunner.ca' &&
          /^\/998\/Event\/[^/]+\/?$/i.test(url.pathname)) ||
        (url.hostname === 'winnipegrotary.org' && /^\/event\/[^/]+\/?$/i.test(url.pathname))
      )
    )
      return [];
    const start = event.StartDate?.slice(0, 10),
      end = event.EndDate?.slice(0, 10);
    if (!validScheduleDay(start) || !validScheduleDay(end) || end < start)
      throw Error('Invalid Rotary calendar event date');
    if (start > window.to || end < window.from) return [];
    const when = parseWhen(event.TimeDescription || '');
    if (when.start !== start || when.end !== end)
      throw Error('Conflicting Rotary calendar event dates');
    return [
      {
        title: clean(event.Title),
        url: url.href,
        location: clean(event.Location || ''),
        when: event.TimeDescription,
        uid: /^[a-f0-9-]{36}$/i.test(event.EntityId || '') ? event.EntityId : undefined,
      },
    ];
  });
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'))?.[1] || '';

/** "Oct. 24, 2026" (or "October 24, 2026") → "2026-10-24". */
function isoDate(month, day, year) {
  const index = MONTHS.indexOf(month.slice(0, 3));
  if (index < 0) return undefined;
  return `${year}-${String(index + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Start/end dates and the time range from text such as "Oct. 24, 2026 6:30 p.m. – 10:00 p.m.". */
export function parseWhen(text) {
  const plain = clean(text);
  const dates = [...plain.matchAll(/\b([A-Z][a-z]{2,8})\.? (\d{1,2}), (\d{4})/g)]
    .map(([, month, day, year]) => isoDate(month, day, year))
    .filter(Boolean);
  const times = [...plain.matchAll(/\d{1,2}:\d{2}\s*[ap]\.?m\.?/gi)].map((match) => match[0]);
  return {
    start: dates[0],
    end: dates.at(-1),
    time: times.length > 1 ? `${times[0]} – ${times.at(-1)}` : times[0] || '',
  };
}

/** Events in the home page "Upcoming Events" box: title, event link, location and date text. */
export function parseUpcomingEvents(html, baseUrl) {
  const list = html.match(/<ul class="upcoming-event-list">([\s\S]*?)<\/ul>/)?.[1] || '';
  return [...list.matchAll(/<li\b[\s\S]*?<\/li>/g)].flatMap(([item]) => {
    const link = item.match(/<a\b[^>]*class="event-name"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) return [];
    const href = attr(link[0], 'href');
    return [
      {
        title: clean(link[1]),
        url: new URL(href, baseUrl).href,
        location: clean(item.match(/<div class="event-location">([\s\S]*?)<\/div>/)?.[1]),
        when: item.match(/<div class="event-date">([\s\S]*?)<\/div>/)?.[1] || '',
      },
    ];
  });
}

/**
 * Details from an event page. The contact person (`.AdditionalInfo`) is deliberately not read:
 * it names a private club member.
 */
export function parseEventPage(html, pageUrl) {
  const uid = html.match(/Event\/Download\/([0-9a-f-]{36})/i)?.[1];
  const lines = (
    html.match(
      /<div class="LocationAddress">[\s\S]*?<td>\s*<img[^>]*>\s*<\/td>\s*<td>([\s\S]*?)<\/td>/,
    )?.[1] || ''
  )
    .split(/<br\s*\/?>/i)
    .map((line) => clean(line))
    .filter((line) => line && line !== 'Canada');
  const [venue = '', ...rest] = lines;
  const poster = attr(
    html.match(/<div class="upcoming-event-image">\s*<img[^>]*>/)?.[0] || '',
    'src',
  );
  return {
    uid,
    title: clean(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1]),
    when: html.match(/<span class="FormattedEventDateWrap">([\s\S]*?)<\/span>/)?.[1] || '',
    venue,
    address: [venue, ...rest].join(', '),
    description: summarize(html.match(/<div class="event-description">([\s\S]*?)<\/div>/)?.[1]),
    poster: poster ? new URL(poster, pageUrl).href : '',
  };
}

/** Large content images on the home page that might be event posters. */
export function posterCandidates(html, baseUrl) {
  return [...html.matchAll(/<img\b[^>]*>/gi)]
    .map(([tag]) => ({ src: attr(tag, 'src'), width: Number(attr(tag, 'width')) || 0 }))
    .filter(({ src, width }) => /\/Images\//.test(src) && width >= 600)
    .map(({ src }) => new URL(src, baseUrl).href)
    .slice(0, MAX_POSTER_CANDIDATES);
}

/** The text of a QR code in a JPEG or PNG image, or null. */
export function readQrCode(bytes) {
  let image;
  if (bytes[0] === 0x89 && bytes[1] === 0x50) image = PNG.sync.read(Buffer.from(bytes));
  else if (bytes[0] === 0xff && bytes[1] === 0xd8)
    image = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 512 });
  else return null;
  const pixels = new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.length);
  return (
    jsQR(pixels, image.width, image.height, { inversionAttempts: 'attemptBoth' })?.data || null
  );
}

const words = (text) =>
  clean(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const longDate = (iso) => {
  const [year, month, day] = iso.split('-').map(Number);
  return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
};

/**
 * Whether a registration page is for `event`: it must contain the event's title (ignoring
 * punctuation) and its date written out ("October 24, 2026").
 */
export function registrationMatches(registrationText, event) {
  const text = words(registrationText);
  return (
    !!event.start &&
    text.includes(words(event.title)) &&
    text.includes(words(longDate(event.start)))
  );
}

/** The "Location:" line of a registration page, e.g. "First Unitarian Church 603 Wellington Crescent". */
export function registrationLocation(registrationText) {
  return (
    clean(registrationText).match(/Location:\s*(.+?)(?=\s+[A-Z][a-z]+(?: [A-Za-z]+)?:\s|$)/)?.[1] ||
    ''
  );
}

/**
 * "Doors Open 6:30 pm · Concert 7:00 pm" from labelled times on a registration page. Labels are
 * one or two words, so the end of a preceding address is not taken as part of the label.
 */
export function registrationTimes(registrationText) {
  return [
    ...clean(registrationText).matchAll(
      /\b([A-Z][a-z]+(?: [A-Za-z]+)?):\s*(\d{1,2}:\d{2}\s*[ap]\.?m\.?)/g,
    ),
  ]
    .map(([, label, time]) => `${label.trim()} ${time}`)
    .join(' · ');
}

/**
 * Collects the club's upcoming public events. Returns the same shape as `collectSourcePages`:
 * `{ items, pagesRead, failedPages, eventPagesRead, eventPageFailures }`. An event whose page
 * fails is still listed from the home page box. Requests are one at a time, `pauseMs` apart.
 */
export async function collectRotary(
  source,
  checkedAt = new Date().toISOString(),
  {
    fetchPage = fetchAllowed,
    pauseMs = 1000,
    onEventPage,
    storePhoto,
    knownListings = new Map(),
  } = {},
) {
  const home = await fetchPage(source.url);
  // No events is normal (the box is then empty); no box at all means the layout changed.
  const calendar = !/upcoming-event-list|Upcoming Events/.test(home.body);
  let upcoming;
  if (calendar) {
    if (!/events\/calendar/i.test(home.body))
      throw Error('Upcoming Events box not found; the home page may have changed');
    const window = collectionWindow(checkedAt);
    const until = new Date(Date.parse(window.to + 'T12:00:00Z') + 86400000)
      .toISOString()
      .slice(0, 10);
    await pause(pauseMs);
    const response = await fetchPage(ROTARY_CALENDAR, {
      json: {
        FromDate: window.from,
        EndDate: until,
        SearchTypes: 'All',
        SelectedAccountIds: '998',
        Month: Number(window.from.slice(5, 7)),
        Year: Number(window.from.slice(0, 4)),
        SearchName: '',
      },
    });
    upcoming = parseRotaryCalendar(response.body, { ...window, until });
  } else upcoming = parseUpcomingEvents(home.body, home.url);
  if (upcoming.length > 100) throw Error('Rotary public event limit reached');
  let eventPagesRead = 0;
  let eventPageFailures = 0;
  const events = [];
  const pages = new Map();
  for (const entry of upcoming) {
    await pause(pauseMs);
    let page = {};
    let pageUrl = entry.url;
    try {
      const response = await fetchPage(entry.url);
      pageUrl = response.url;
      page = parseEventPage(response.body, response.url);
      pages.set(pageUrl, response.body);
      eventPagesRead++;
    } catch {
      eventPageFailures++;
    }
    const when = parseWhen(page.when || entry.when);
    events.push({
      id:
        page.uid || entry.uid
          ? `${ROTARY_SOURCE_ID}-${page.uid || entry.uid}`
          : eventListingId(ROTARY_SOURCE_ID, pageUrl),
      title: page.title || entry.title,
      url: pageUrl,
      start: when.start,
      end: when.end,
      time: when.time,
      venue: page.venue || entry.location || 'Location not confirmed',
      address: page.address || entry.location || '',
      image: page.poster || '',
      images: page.poster ? [page.poster] : [],
      description: page.description,
    });
  }

  // Full-size posters: accept one only when its QR code leads to this event's registration page.
  for (const posterUrl of posterCandidates(home.body, home.url)) {
    try {
      await pause(pauseMs);
      const qr = readQrCode((await fetchPage(posterUrl, { binary: true })).body);
      if (!qr || !/^https:\/\//.test(qr)) continue;
      await pause(pauseMs);
      const registration = await fetchPage(qr);
      if (!/\/eventportal\//i.test(new URL(registration.url).pathname)) continue;
      const event = events.find((candidate) => registrationMatches(registration.body, candidate));
      if (!event) continue;
      event.image = posterUrl;
      event.images = [posterUrl, ...event.images.filter((image) => image !== posterUrl)];
      event.ticketUrl = registration.url;
      event.time = registrationTimes(registration.body) || event.time;
      // The registration page spells the address correctly more often than the event page.
      event.address = registrationLocation(registration.body) || event.address;
    } catch {
      // A poster that can't be read or matched simply isn't attached.
    }
  }

  const items = events.map((event) => ({
    ...event,
    type: 'Event',
    category: categoryFor(event.title),
    schedule: 'event',
    neighbourhood: 'Winnipeg',
    source: ROTARY_SOURCE_ID,
    sourceName: source.name,
    checkedAt,
    price: null,
    family: false,
    indoor: false,
    description: event.description || placeholderDescription(source.name),
    status: 'active',
  }));
  const validatePhoto = (value) => {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !ALLOWED_HOSTS.has(url.hostname) ||
      url.username ||
      url.password
    )
      throw Error('Refused event photo URL');
    return url.href;
  };
  const cache = storedPhotoCache(knownListings, validatePhoto);
  const bounded = boundedHtmlEvents(items, checkedAt);
  const failedPages = [];
  for (const item of bounded) {
    if (storePhoto) {
      try {
        await collectEventPhotos(item, item.images.map(validatePhoto), {
          read: async (url) => {
            await pause(pauseMs);
            return (await fetchPage(validatePhoto(url), { binary: true })).body;
          },
          storePhoto,
          cache,
        });
      } catch {
        retainEventPhotos(item, knownListings.get(item.id));
        failedPages.push({
          url: item.url,
          error: 'Rotary photo enrichment failed; previous photos retained',
        });
      }
    }
    if (onEventPage && pages.has(item.url))
      onEventPage({
        id: item.id,
        itemIds: [item.id],
        url: item.url,
        html: pages.get(item.url),
        selector: 'h1, .upcoming-event-image, div.upcoming-event',
        exclude: '.AdditionalInfo, .SocialMedia, .event-contact',
        refineDateOnly: true,
        ...(calendar ? { calendarSchedule: 'dates' } : {}),
      });
  }
  return {
    items: bounded,
    pagesRead: calendar ? 2 : 1,
    failedPages,
    eventPagesRead,
    eventPageFailures,
    allowEmpty: true,
  };
}
