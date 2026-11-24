// Event session dates and times: the collection window, local wall-clock conversion, session
// normalization and verified visiting hours. Extraction supplies facts; this module never scrapes.
import { localDay } from './connectors.mjs';
import { clockLabel, zonedInstant } from './time-zone.mjs';

export const DEFAULT_TIME_ZONE = 'America/Winnipeg'; // the only zone lib/time-zone.mjs supports
export const validScheduleDay = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
const dayOf = (value) => (value?.includes('T') ? localDay(new Date(value)) : value);
const addDay = (day, count = 1) =>
  new Date(Date.parse(day + 'T12:00:00Z') + count * 86400000).toISOString().slice(0, 10);

export function collectionWindow(checkedAt = new Date().toISOString()) {
  const from = localDay(new Date(checkedAt)).slice(0, 7) + '-01';
  const end = new Date(from + 'T12:00:00Z');
  end.setUTCMonth(end.getUTCMonth() + 2);
  end.setUTCDate(0);
  return { from, to: end.toISOString().slice(0, 10) };
}

/**
 * Convert a verified Winnipeg wall time to an instant with the checked-in zone table
 * (lib/time-zone.mjs), never the host's or runtime's time zone data.
 */
export function zonedTimestamp(
  day,
  time,
  timeZone = DEFAULT_TIME_ZONE,
  { rejectAmbiguous = false } = {},
) {
  if (!validScheduleDay(day) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw Error('Invalid local schedule time');
  return zonedInstant(day, time, timeZone, { rejectAmbiguous });
}

/** Short, stable, non-cryptographic hash (FNV-1a) for ID suffixes. */
function shortHash(text) {
  let hash = 0x811c9dc5;
  for (const char of text) hash = Math.imul(hash ^ char.codePointAt(0), 0x01000193) >>> 0;
  return hash.toString(36);
}

/** Stable session ID from the event's source, URL path and start instant. */
function occurrenceId(sourceId, eventUrl, startAt) {
  const url = new URL(eventUrl);
  url.searchParams.set('occurrence', new Date(startAt).toISOString());
  const segments = url.pathname
    .split('/')
    .filter((segment) => segment && !['events', 'calendar-of-events'].includes(segment));
  let slug = segments
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > 80) slug = slug.slice(0, 70).replace(/-+$/, '') + '-' + shortHash(url.pathname);
  slug += '-' + shortHash(url.search);
  return `${sourceId}-${slug}`;
}

/** @param {any} input @param {any} event */
export function normalizeOccurrence(input, event) {
  const startAt = input.startAt || (input.start?.includes('T') ? input.start : undefined);
  const endAt = input.endAt || (input.end?.includes('T') ? input.end : undefined) || startAt;
  const start = startAt ? dayOf(startAt) : input.start;
  const end = endAt ? dayOf(endAt) : input.end || start;
  if (!validScheduleDay(start) || !validScheduleDay(end) || end < start)
    throw Error('Invalid occurrence dates');
  if (
    startAt &&
    (!Number.isFinite(Date.parse(startAt)) ||
      !Number.isFinite(Date.parse(endAt)) ||
      Date.parse(endAt) < Date.parse(startAt))
  )
    throw Error('Invalid occurrence timestamps');
  const timeZone = input.timeZone || DEFAULT_TIME_ZONE;
  const format = (value) => clockLabel(value, timeZone);
  const time =
    input.time ??
    (startAt?.includes('T')
      ? format(startAt) + (startAt !== endAt ? ' – ' + format(endAt) : '')
      : '');
  const identity = startAt || start + 'T12:00:00Z';
  const id =
    input.id ||
    occurrenceId(event.source, event.eventUrl || event.url, identity) +
      (startAt ? '' : '-' + encodeURIComponent(time));
  const url = input.url || event.url;
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw Error('Invalid occurrence URL');
  return {
    id,
    start,
    end,
    ...(typeof input.duplicateOf === 'string' ? { duplicateOf: input.duplicateOf } : {}),
    ...(typeof input.derivedFrom === 'string' ? { derivedFrom: input.derivedFrom } : {}),
    ...(input.sourceOverrides
      ? {
          sourceOverrides: Object.fromEntries(
            Object.entries(input.sourceOverrides).filter(
              ([key, value]) =>
                ['title', 'description', 'venue'].includes(key) && typeof value === 'string',
            ),
          ),
        }
      : {}),
    ...(startAt
      ? { startAt: new Date(startAt).toISOString(), endAt: new Date(endAt).toISOString() }
      : {}),
    time,
    timeZone,
    ...(input.endTimeKnown === false ? { endTimeKnown: false } : {}),
    url,
    status: input.cancelled
      ? 'cancelled'
      : ['active', 'cancelled', 'superseded'].includes(input.status)
        ? input.status
        : 'active',
    basis: input.basis || (event.runDates || event.type === 'Place' ? 'calendar' : 'event'),
    ...(input.publishedStart || startAt ? { publishedStart: input.publishedStart || startAt } : {}),
    ...(input.publishedEnd || endAt ? { publishedEnd: input.publishedEnd || endAt } : {}),
  };
}

/** @param {any} schedule @param {any} event @param {any} window */
export function materializeVisitingHours(schedule, event, window, timeOptions = {}) {
  if (!schedule?.sourceUrl || !schedule.checkedAt || !Array.isArray(schedule.periods))
    throw Error('Verified visiting schedule required');
  const periods = schedule.periods;
  for (const p of [...periods, ...(schedule.exceptions || [])])
    if (!validScheduleDay(p.from) || !validScheduleDay(p.to) || p.to < p.from)
      throw Error('Invalid schedule period');
  const occurrences = [],
    days = [];
  for (let day = window.from; day <= window.to; day = addDay(day)) {
    if (
      (event.start && day < event.start) ||
      (event.end && day > event.end) ||
      (event.endMonth && day.slice(0, 7) > event.endMonth)
    )
      continue;
    const matching = periods.filter((p) => p.from <= day && p.to >= day);
    if (matching.length > 1) throw Error('Overlapping weekly schedule periods');
    const overrides = (schedule.exceptions || [])
      .filter((p) => p.from <= day && p.to >= day)
      .sort(
        (a, b) => Date.parse(a.to) - Date.parse(a.from) - (Date.parse(b.to) - Date.parse(b.from)),
      );
    if (
      overrides.length > 1 &&
      Date.parse(overrides[0].to) - Date.parse(overrides[0].from) ===
        Date.parse(overrides[1].to) - Date.parse(overrides[1].from)
    )
      throw Error('Conflicting schedule exceptions');
    const override = overrides[0];
    if (!matching.length && !override) continue;
    days.push(day);
    const weekday = new Date(day + 'T12:00:00Z').getUTCDay();
    const intervals = override
      ? override.closed
        ? []
        : override.intervals || []
      : (matching[0].weekly || []).filter((s) => s.weekdays.includes(weekday));
    for (const interval of intervals) {
      const startAt = zonedTimestamp(day, interval.opens, schedule.timeZone, timeOptions),
        endAt = zonedTimestamp(
          interval.closes <= interval.opens ? addDay(day) : day,
          interval.closes,
          schedule.timeZone,
          timeOptions,
        );
      occurrences.push(
        normalizeOccurrence(
          { startAt, endAt, timeZone: schedule.timeZone, url: schedule.sourceUrl, basis: 'hours' },
          event,
        ),
      );
    }
  }
  const coverage = [];
  for (const day of days) {
    const last = coverage.at(-1);
    if (last && addDay(last.to) === day) last.to = day;
    else
      coverage.push({
        from: day,
        to: day,
        complete: true,
        checkedAt: schedule.checkedAt,
        sourceUrl: schedule.sourceUrl,
        basis: 'hours',
      });
  }
  return { occurrences, coverage };
}

/** Expand only a source's explicitly printed class weekday; unrecognized exclusions stay unknown. @param {any} event @param {any} window */
/** @param {any} event @param {string} date */
export function availabilityOn(event, date) {
  if (!validScheduleDay(date)) throw Error('Invalid visit date');
  const active = (event.occurrences || []).filter(
    (o) => !o.hidden && o.status === 'active' && o.start <= date && o.end >= date,
  );
  if (['hidden', 'cancelled'].includes(event.status))
    return { status: 'unavailable', date, intervals: [], reason: 'Event unavailable' };
  if (
    (event.start && date < event.start) ||
    (event.end && date > event.end) ||
    (event.endMonth && date.slice(0, 7) > event.endMonth)
  )
    return { status: 'unavailable', date, intervals: [], reason: 'Outside the event run' };
  if (active.length)
    return {
      status: 'available',
      date,
      intervals: active,
      hoursKnown: active.every((o) => !!o.time && o.endTimeKnown !== false),
    };
  if ((event.scheduleCoverage || []).some((c) => c.complete && c.from <= date && c.to >= date))
    return { status: 'unavailable', date, intervals: [], reason: 'No scheduled availability' };
  return { status: 'unknown', date, intervals: [], reason: 'Schedule not confirmed for this date' };
}
