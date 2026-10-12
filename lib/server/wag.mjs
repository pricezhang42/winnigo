// WAG calendar + detail pages. Browser transport stays in the worker, never in page reads.
import { load } from 'cheerio';
import { setTimeout as pause } from 'node:timers/promises';
import { eventListingId, localDay, summarize } from '../connectors.mjs';
import { createWagFetcher, wagUrl } from './flaresolverr.mjs';

export const WAG_SOURCE_ID = 'wag';
export const WAG_CALENDAR = 'https://www.wag.ca/events/event-calendar/';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const tidy = (text) => text.replace(/\s+/g, ' ').trim();
const plain = (node) => {
  const copy = node.clone();
  copy.find('script,style,template,.sharethis-inline-share-buttons').remove();
  copy.find('br').replaceWith('\n');
  copy.find('div,p,li,h2,h3,h4,h5,h6').append('\n');
  return copy.text().split('\n').map(tidy).filter(Boolean).join('\n');
};
const day = (year, month, date) => {
  const value = `${year}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
  const parsed = new Date(value + 'T12:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
};

/** Years must be printed by WAG, never inferred from today's year. */
export function parseWagDates(text, yearHint) {
  text = tidy(text)
    .replace(/[’‘]/g, "'")
    .replace(/\b([A-Za-z]+) (\d{1,2})\s*[–—-]\s*(\d{1,2})\b/g, '$1 $2 - $1 $3');
  const parts = [
    ...text.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:\s*,?\s*(?:'(\d{2})\b|(20\d{2})\b))?/g),
  ]
    .map(([, month, date, shortYear, year]) => ({
      month: MONTHS.indexOf(month.slice(0, 3).toLowerCase()) + 1,
      date: +date,
      year: year ? +year : shortYear ? 2000 + +shortYear : null,
    }))
    .filter((part) => part.month);
  if (!parts.length || parts.length > 2) return null;
  const finalYear = parts.at(-1).year || parts[0].year || yearHint;
  if (!finalYear) return null;
  if (parts.length === 2 && !parts[0].year && parts[0].month > parts[1].month)
    parts[0].year = finalYear - 1;
  const dates = parts.map((part) => day(part.year || finalYear, part.month, part.date));
  if (dates.some((date) => !date) || dates.at(-1) < dates[0]) return null;
  return { start: dates[0], end: dates.at(-1) };
}

const canonicalEvent = (value) => {
  const url = wagUrl(new URL(value, WAG_CALENDAR).href);
  if (!/^\/event\/[^/]+\/?$/.test(url.pathname)) throw Error('Not a WAG event URL');
  url.pathname = url.pathname.replace(/\/?$/, '/');
  url.search = '';
  url.hash = '';
  return url.href;
};

export function parseWagCalendar(html) {
  const $ = load(html);
  const section = $('#returned-posts');
  if (section.length !== 1) throw Error('WAG calendar layout changed: event list missing');
  const entries = section
    .find('a.event-card')
    .toArray()
    .map((element) => {
      const card = $(element);
      const title = tidy(card.find('h3').text());
      if (!title) throw Error('WAG calendar card has no title');
      return {
        url: canonicalEvent(card.attr('href')),
        title,
        subtitle: tidy(card.find('h6').text()),
        when: tidy(card.find('.event-date').text()),
      };
    });
  const empty = /Your search didn[’']t return any events/i.test(section.text());
  if (!entries.length && !empty) throw Error('WAG calendar layout changed: no event cards');
  const more = $('.btn-more');
  let pagination = null;
  if (more.length) {
    const next = Number(more.attr('data-next'));
    const total = Number(more.attr('data-total'));
    const base = wagUrl(new URL(more.attr('href'), WAG_CALENDAR).href);
    if (
      base.pathname !== '/events/event-calendar/' ||
      !base.searchParams.has('paged') ||
      !Number.isInteger(next) ||
      next < 2 ||
      !Number.isInteger(total) ||
      total < next
    )
      throw Error('WAG pagination layout changed');
    pagination = { base: base.href, next, total };
  }
  return { entries, empty, pagination };
}

/** Event artwork only: exclude sponsor/related-story images and duplicate WordPress sizes. */
export function parseWagImages($, body, eventUrl) {
  const images = new Map();
  const add = (value, alt = '') => {
    if (!value || images.size >= 3) return;
    let url;
    try {
      url = new URL(value, eventUrl);
    } catch {
      return;
    }
    if (
      url.origin !== 'https://www.wag.ca' ||
      url.username ||
      url.password ||
      !/^\/isl\/uploads\/.+\.(?:jpe?g|png|webp)$/i.test(url.pathname) ||
      /logo|sponsor|headshot|letterhead|icon/i.test(url.pathname + ' ' + alt)
    )
      return;
    url.hash = '';
    const key = url.pathname.replace(/(?:-\d+x\d+|-scaled)+(?=\.[^.]+$)/i, '');
    if (!images.has(key)) images.set(key, url.href);
  };
  const background = $('main .event-featured-img').first().attr('style') || '';
  add(background.match(/background-image\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/i)?.[1]);
  add($('meta[property="og:image"]').first().attr('content'));
  body.find('img').each((_, element) => {
    const img = $(element);
    if (
      img.closest('.sidebar,.sponsor,.sponsors,.event-card,.story-card,.people-modal,.modal').length
    )
      return;
    // Linked logos often lack useful filenames. Only image links belong in an event gallery.
    const link = img.closest('a').attr('href');
    if (link && !/\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(link)) return;
    const full = link || img.attr('data-src') || img.attr('src');
    add(full, img.attr('alt'));
  });
  return [...images.values()];
}

function recurrenceConflict(text, dates) {
  const match = text.match(
    /\b(first|second|third|fourth|fifth)\s+(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+of\s+([A-Za-z]+)/i,
  );
  if (!match || !dates || dates.start !== dates.end) return false;
  const ordinal =
    ['first', 'second', 'third', 'fourth', 'fifth'].indexOf(match[1].toLowerCase()) + 1;
  const weekday = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
  ].indexOf(match[2].toLowerCase());
  const month = MONTHS.indexOf(match[3].slice(0, 3).toLowerCase()) + 1;
  if (!month) return false;
  const date = new Date(dates.start + 'T12:00:00Z');
  return (
    month !== date.getUTCMonth() + 1 ||
    weekday !== date.getUTCDay() ||
    ordinal !== Math.ceil(date.getUTCDate() / 7)
  );
}

/** Only the event's own content is read; sponsors, people, stories and related events are excluded. */
export function parseWagEvent(html, entry, checkedAt, sourceName = 'WAG–Qaumajuq') {
  const $ = load(html);
  $('script,style,template').remove();
  const hero = $('#maincontent .hero').first();
  const info = $('#maincontent .event-info').first();
  const heading = $('main h1').first();
  if (!hero.length || !info.length || !heading.length)
    throw Error('WAG event layout changed: title, description or event info missing');
  const title = tidy(heading.text());
  const subtitle = tidy($('main .banner-subtitle').first().text());
  const body = hero.parent();
  const sidebar = $('#maincontent .sidebar').first();
  const dateNode = info.clone();
  dateNode.find('.event-time').remove();
  const dateText = plain(dateNode);
  const cardDates = parseWagDates(entry.when);
  const detailDates = parseWagDates(
    dateText.split(/\*?\s*No classes/i)[0],
    cardDates ? Number(cardDates.end.slice(0, 4)) : undefined,
  );
  if (
    cardDates &&
    detailDates &&
    (cardDates.start !== detailDates.start || cardDates.end !== detailDates.end)
  )
    return { review: 'Calendar and detail dates disagree' };
  if (
    cardDates &&
    !detailDates &&
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d/i.test(dateText)
  )
    return { review: 'Detail date could not be confirmed' };
  const dates = detailDates || cardDates;
  const multipleOptions = /multiple dates|ongoing|select (?:dates|afternoons)/i.test(dateText);
  const recurring = /\b(?:Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)days(?=\s|\d|$)/i.test(
    dateText + ' ' + plain(info.find('.event-time')),
  );
  const series = multipleOptions || recurring;
  if (!dates && !multipleOptions)
    return { review: 'Event dates have no confirmed year or are unrecognized' };
  if (recurrenceConflict(plain(body), dates))
    return { review: 'Printed date conflicts with the stated weekday/recurrence' };
  if (dates && dates.end < localDay(new Date(checkedAt))) return { stale: true };

  const widgets = sidebar
    .find('.widget')
    .filter((_, node) => !$(node).find('.sharethis-inline-share-buttons').length);
  const timeText = plain(info.find('.event-time'));
  const schedule = timeText.split('\n').filter((line) => /\d\s*(?:[ap]\.?m\.?)/i.test(line));
  const admission = timeText
    .split('\n')
    .filter((line) => /\$|free|admission|tickets coming/i.test(line));
  const publicLines = widgets
    .find('p')
    .toArray()
    .map((node) => plain($(node)))
    .filter((line) => !/@|contact|\d{3}[. -]\d{3}[. -]\d{4}/i.test(line));
  // Don't mistake one sold-out option in a multi-class landing page for the whole series.
  const soldOut =
    /^sold[ -]out\b/i.test(title) || publicLines.some((line) => /^sold[ -]out[!.\s]*$/i.test(line));
  const cancelled =
    /\bthis event (?:has been|is) cancelled\b/i.test(plain(hero)) ||
    /^cancelled\b/i.test(title) ||
    publicLines.some((line) => /^(?:event\s+)?cancelled[!.\s]*$/i.test(line));
  const admissionText =
    admission.join(' · ') ||
    (publicLines.some((line) => /^free (?:entry|admission)[!.\s]*$/i.test(line)) ||
    /\bfree admission to WAG[–-]Qaumajuq\b/i.test(plain(hero))
      ? 'Free admission'
      : '');
  const amounts = [...admissionText.matchAll(/\$(\d[\d,]*(?:\.\d{2})?)/g)].map((m) =>
    Number(m[1].replaceAll(',', '')),
  );
  // Discounts/free parking never turn a paid event into a free listing.
  const price =
    amounts.length === 1
      ? amounts[0]
      : amounts.length
        ? null
        : /^free (?:entry|admission)$/i.test(admissionText)
          ? 0
          : null;
  const audience = /\bages?\b|year olds|adults|famil/i.test(subtitle) ? subtitle : '';
  const ticketLink = sidebar
    .find('a[href]')
    .toArray()
    .find(
      (node) =>
        /\b(?:buy|book|register|registration|tickets)\b/i.test($(node).text()) &&
        !/sponsor|donat|question/i.test($(node).text()),
    );
  let ticketUrl;
  if (ticketLink) {
    const candidate = new URL($(ticketLink).attr('href'), entry.url);
    if (candidate.protocol === 'https:' && !candidate.username && !candidate.password)
      ticketUrl = candidate.href;
  }
  const notes = [
    cancelled ? 'Cancelled.' : soldOut ? 'Sold out.' : '',
    admissionText ? `Admission: ${admissionText}.` : '',
    audience ? `Audience: ${audience}.` : '',
    series
      ? `Schedule: ${dateText}. ${plain(info.find('.event-time'))}. See the source for class options and exclusions.`
      : '',
    ...publicLines
      .filter((line) => !series && !/sold[ -]out/i.test(line))
      .filter((line) => /\b(?:\d\s*[ap]m|tickets coming|free entry)\b/i.test(line))
      .slice(0, 3),
  ].filter(Boolean);
  const description = summarize(notes.join(' ') + ' ' + plain(hero));
  const images = parseWagImages($, body, entry.url);
  return {
    item: {
      id: eventListingId(WAG_SOURCE_ID, entry.url),
      source: WAG_SOURCE_ID,
      sourceName,
      checkedAt,
      url: entry.url,
      title: [title, subtitle].filter(Boolean).join(' — '),
      type: series ? 'Activity' : 'Event',
      category: 'Arts & culture',
      venue: 'WAG–Qaumajuq',
      address: '300 Memorial Boulevard, Winnipeg',
      neighbourhood: 'Downtown',
      ...(dates || {}),
      time: schedule.join(' · '),
      schedule: series ? dateText : 'event',
      price,
      admission: admissionText,
      audience,
      family: /famil|kids|children|ages?\s*\d/i.test(audience + ' ' + plain(hero)),
      indoor: true,
      availability: soldOut ? 'sold-out' : 'unknown',
      status: cancelled ? 'cancelled' : 'active',
      description,
      image: images[0] || '',
      images,
      ...(ticketUrl ? { ticketUrl } : {}),
    },
  };
}

/** Bounded serial run; partial results never imply that unseen events were cancelled. */
export async function collectWag(
  source,
  checkedAt = new Date().toISOString(),
  {
    fetchPage,
    storePhoto,
    pauseMs = 1000,
    maxPages = 5,
    maxEvents = 60,
    maxRunMs = 450000,
    signal = AbortSignal.timeout(maxRunMs),
  } = {},
) {
  fetchPage ??= createWagFetcher({ signal });
  const result = {
    items: [],
    pagesRead: 0,
    failedPages: [],
    eventPagesRead: 0,
    eventPageFailures: 0,
    skippedPast: 0,
    reviewRequired: 0,
    discovered: 0,
    allowEmpty: false,
  };
  const failure = (url, error) => result.failedPages.push({ url, error });
  const read = async (url, options) => {
    signal.throwIfAborted();
    await pause(pauseMs, undefined, { signal });
    return fetchPage(url, options);
  };
  const first = parseWagCalendar((await read(source.url)).body);
  result.pagesRead++;
  const entries = new Map(first.entries.map((entry) => [entry.url, entry]));
  const pagination = first.pagination;
  if (pagination) {
    for (let page = pagination.next; page <= pagination.total; page++) {
      const url = new URL(pagination.base);
      url.searchParams.set('paged', String(page));
      if (result.pagesRead >= maxPages) {
        failure(url.href, 'Calendar page limit reached');
        break;
      }
      try {
        const parsed = parseWagCalendar((await read(url.href)).body);
        result.pagesRead++;
        const added = parsed.entries.filter((entry) => !entries.has(entry.url));
        // An advertised page returning no cards is not proof of a complete calendar.
        if (!added.length) throw Error('Advertised calendar page returned no new events');
        for (const entry of added) entries.set(entry.url, entry);
      } catch (error) {
        failure(url.href, error.message);
        break;
      }
    }
  }
  result.discovered = entries.size;
  let attempted = 0;
  for (const entry of entries.values()) {
    if (attempted >= maxEvents) {
      failure(entry.url, 'Event page limit reached');
      break;
    }
    if (signal.aborted) {
      failure(entry.url, 'Collection time limit reached');
      break;
    }
    try {
      attempted++;
      const page = await read(entry.url);
      result.eventPagesRead++;
      const parsed = parseWagEvent(page.body, entry, checkedAt, source.name);
      if (parsed.stale) result.skippedPast++;
      else if (parsed.review) {
        result.reviewRequired++;
        failure(entry.url, parsed.review);
      } else {
        if (storePhoto && parsed.item.images.length) {
          try {
            const stored = [];
            for (const url of parsed.item.images) {
              signal.throwIfAborted();
              stored.push(await storePhoto(await fetchPage.fetchPhoto(url)));
            }
            parsed.item.sourceImages = parsed.item.images;
            parsed.item.images = stored;
            parsed.item.image = stored[0];
          } catch {
            failure(entry.url, 'Event photos unavailable; listing retained for a later retry');
            continue;
          }
        }
        result.items.push(parsed.item);
      }
    } catch (error) {
      result.eventPageFailures++;
      failure(entry.url, error.message);
    }
  }
  result.allowEmpty =
    result.failedPages.length === 0 && (first.empty || result.skippedPast === entries.size);
  return result;
}
