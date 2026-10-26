// The Events Calendar month JSON-LD, shared by Museum and FortWhyte adapters.
import { load } from 'cheerio';
import { localDay } from '../connectors.mjs';
import { validScheduleDay } from '../event-schedule.mjs';
const clean = (value) =>
  load(String(value || ''))
    .text()
    .replace(/\s+/g, ' ')
    .trim();
const wallDay = (value) => {
  if (validScheduleDay(value)) return value;
  if (
    typeof value !== 'string' ||
    !/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !validScheduleDay(value.slice(0, 10)) ||
    !Number.isFinite(Date.parse(value))
  )
    throw Error('Calendar occurrence date is invalid');
  return localDay(new Date(value));
};

export function tribeTimestamp(value) {
  if (!/-(?:05|06):00$/.test(value)) return value;
  const offset = new Intl.DateTimeFormat('en', {
    timeZone: 'America/Winnipeg',
    timeZoneName: 'longOffset',
  })
    .formatToParts(new Date(value))
    .find((part) => part.type === 'timeZoneName')
    .value.replace('GMT', '');
  const corrected = value.slice(0, 19) + offset;
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Winnipeg',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(corrected));
  if (local !== value.slice(11, 19)) throw Error('Calendar occurrence local time is invalid');
  return corrected;
}

export function parseTribeMonth(
  html,
  expectedMonth,
  { label, url: sourceUrl, timestamp = (v) => v, groupKey },
) {
  const $ = load(html);
  const events = [];
  $('script[type="application/ld+json"]').each((_, node) => {
    let data;
    try {
      data = JSON.parse($(node).text());
    } catch {
      throw Error(`${label} calendar JSON-LD is malformed`);
    }
    const nodes = Array.isArray(data) ? data : [data, ...(data?.['@graph'] || [])];
    for (const event of nodes) {
      if (
        !(Array.isArray(event?.['@type'])
          ? event['@type'].includes('Event')
          : event?.['@type'] === 'Event')
      )
        continue;
      const url = sourceUrl(event.url);
      wallDay(event.startDate);
      wallDay(event.endDate || event.startDate);
      const startDate = timestamp(event.startDate);
      const endDate = timestamp(event.endDate || event.startDate);
      const startDay = wallDay(startDate);
      const endDay = wallDay(endDate);
      if (Date.parse(endDate) < Date.parse(startDate) || !clean(event.name))
        throw Error(`${label} event dates/title are invalid`);
      events.push({
        ...event,
        url,
        startDate,
        endDate,
        startDay,
        endDay,
        groupKey: groupKey(url),
        endDateKnown: Boolean(event.endDate),
        publishedStartDate: event.startDate,
        publishedEndDate: event.endDate || event.startDate,
      });
    }
  });
  const view = $('script[data-js="tribe-events-view-data"]').first();
  if (expectedMonth && view.length) {
    let data;
    try {
      data = JSON.parse(view.text());
    } catch {
      throw Error(`${label} month view data is malformed`);
    }
    if (data.url_event_date && String(data.url_event_date).slice(0, 7) !== expectedMonth)
      throw Error(`${label} returned a different calendar month`);
  }
  // A calendar template plus an explicit empty result is required to accept an empty month.
  const empty =
    /No events scheduled|No results found|There were no results|No matching events/i.test($.text());
  if (!events.length && !(empty && (view.length || $('[data-view="month"]').length)))
    throw Error(`${label} month layout changed or event data missing`);
  const next = $('a[rel="next"]').first().attr('href');
  return {
    events,
    empty,
    viewData: view.length ? JSON.parse(view.text()) : null,
    next: next ? sourceUrl(next, 'month') : null,
  };
}
