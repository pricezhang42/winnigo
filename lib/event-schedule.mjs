// Shared event/occurrence contract. Adapters supply facts; this module never scrapes.
import { localDay, occurrenceListingId } from './connectors.mjs';

export const DEFAULT_TIME_ZONE = 'America/Winnipeg';
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

/** Convert verified local wall time to an instant, without using the host timezone. */
export function zonedTimestamp(day, time, timeZone = DEFAULT_TIME_ZONE) {
  if (!validScheduleDay(day) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw Error('Invalid local schedule time');
  const wanted = Date.parse(day + 'T' + time + ':00Z');
  let guess = wanted;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(
      formatter.formatToParts(new Date(guess)).map((v) => [v.type, v.value]),
    );
    const actual = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    if (actual === wanted) return new Date(guess).toISOString();
    guess += wanted - actual;
  }
  throw Error('Local schedule time does not exist');
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
  new Intl.DateTimeFormat('en', { timeZone });
  const format = (value) =>
    new Date(value).toLocaleTimeString('en-CA', { timeZone, hour: 'numeric', minute: '2-digit' });
  const time =
    input.time ??
    (startAt?.includes('T')
      ? format(startAt) + (startAt !== endAt ? ' – ' + format(endAt) : '')
      : '');
  const identity = startAt || start + 'T12:00:00Z';
  const id =
    input.id ||
    occurrenceListingId(event.source, event.eventUrl || event.url, identity) +
      (startAt ? '' : '-' + encodeURIComponent(time));
  const url = input.url || event.url;
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw Error('Invalid occurrence URL');
  return {
    id,
    start,
    end,
    ...(startAt
      ? { startAt: new Date(startAt).toISOString(), endAt: new Date(endAt).toISOString() }
      : {}),
    time,
    timeZone,
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
export function materializeVisitingHours(schedule, event, window) {
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
      const startAt = zonedTimestamp(day, interval.opens, schedule.timeZone),
        endAt = zonedTimestamp(
          interval.closes <= interval.opens ? addDay(day) : day,
          interval.closes,
          schedule.timeZone,
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
function classOccurrences(event, window) {
  if (!event.scheduleText || !event.start || !event.end) return [];
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const weekdays = names
    .map((n, i) => (new RegExp('\\b' + n + 's?\\b', 'i').test(event.scheduleText) ? i : -1))
    .filter((i) => i >= 0);
  if (weekdays.length !== 1) return [];
  const exclusions = [];
  const noClasses = event.scheduleText.match(/No classes\s+([\s\S]*?)(?:[·\n]|$)/i)?.[1];
  if (noClasses) {
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const matches = [...noClasses.matchAll(/\b([A-Za-z]+)\s+(\d{1,2})\b/g)];
    if (!matches.length) return [];
    for (const m of matches) {
      const month = months.findIndex((n) => m[1].toLowerCase().startsWith(n.toLowerCase()));
      if (month < 0) return [];
      const date =
        event.start.slice(0, 4) +
        '-' +
        String(month + 1).padStart(2, '0') +
        '-' +
        m[2].padStart(2, '0');
      if (!validScheduleDay(date)) return [];
      exclusions.push(date);
    }
  }
  const occurrences = [];
  for (let day = window.from; day <= window.to; day = addDay(day))
    if (
      day >= event.start &&
      day <= event.end &&
      new Date(day + 'T12:00:00Z').getUTCDay() === weekdays[0] &&
      !exclusions.includes(day)
    )
      occurrences.push(
        normalizeOccurrence(
          { start: day, end: day, time: event.time || '', url: event.url },
          event,
        ),
      );
  return occurrences;
}

/** Shared adapter normalization, including old per-session Museum/swim records. @param {any[]} items @param {string} checkedAt */
export function normalizeEvents(
  items,
  checkedAt = new Date().toISOString(),
  { bounded = false } = {},
) {
  const window = collectionWindow(checkedAt),
    groups = new Map();
  for (const item of items) {
    const groupId = item.seriesId || item.id;
    const key = item.source + '|' + groupId;
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  const result = [];
  for (const group of groups.values()) {
    const first = group[0];
    const parent = { ...first, id: first.seriesId || first.id };
    const isPlace = first.type === 'Place';
    delete parent.occurrenceMode;
    parent.eventUrl =
      first.eventUrl ||
      (first.schedule === 'series' || first.seriesId
        ? first.url.replace(/\/20\d\d-\d\d-\d\d\/(?:\d+\/)?$/, '/')
        : first.url);
    if (first.seriesId || first.schedule === 'series') parent.url = parent.eventUrl;
    const sessions = new Map();
    for (const item of group) {
      let inputs = item.occurrences?.length ? item.occurrences : undefined;
      if (!inputs && item.occurrenceSamples?.length)
        inputs = item.occurrenceSamples.map((sample) => ({
          ...sample,
          id: item.recurring && item.startAt ? item.id : undefined,
        }));
      if (!inputs && item.schedule === 'event' && item.start)
        inputs = [
          {
            id: item.id,
            start: item.start,
            end: item.end,
            time: item.time,
            startAt: item.startAt,
            endAt: item.endAt,
            url: item.url,
            status: item.status,
          },
        ];
      if (!inputs && item.schedule === 'series') inputs = classOccurrences(item, window);
      for (const input of inputs || []) {
        const session = normalizeOccurrence(input, parent);
        // Older occurrences remain historical; only newly materialized schedules use this window.
        if (
          !bounded ||
          (!first.seriesId && !first.recurring && first.schedule !== 'series') ||
          (session.end >= window.from && session.start <= window.to)
        )
          sessions.set(session.id, session);
      }
    }
    parent.recurring =
      !isPlace &&
      (!!first.recurring ||
        !!first.seriesId ||
        !!first.runDates ||
        !!first.visitingSchedule ||
        first.schedule === 'series' ||
        (first.recurring === undefined && sessions.size > 1));
    if (group.some((item) => item.seriesId)) parent.status = 'active';
    if (first.seriesId) {
      delete parent.start;
      delete parent.end;
      delete parent.endMonth;
      delete parent.time;
      if (first.scheduleStart) parent.start = first.scheduleStart;
      if (first.scheduleEnd) parent.end = first.scheduleEnd;
    }
    if (parent.recurring) {
      parent.schedule = 'series';
      parent.type = 'Event';
      parent.time = '';
    }
    const coverage = [...(first.scheduleCoverage || [])].filter(
      (c) =>
        first.visitingSchedule === undefined ||
        c.basis !== 'hours' ||
        c.to < window.from ||
        c.from > window.to,
    );
    if (first.visitingSchedule !== undefined)
      for (const [id, o] of sessions)
        if (o.basis === 'hours' && o.start >= window.from && o.start <= window.to)
          sessions.delete(id);
    if (first.visitingSchedule) {
      const materialized = materializeVisitingHours(first.visitingSchedule, parent, window);
      for (const o of materialized.occurrences) sessions.set(o.id, o);
      coverage.push(...materialized.coverage);
    }
    parent.occurrences = [...sessions.values()].sort(
      (a, b) =>
        (a.startAt || a.start).localeCompare(b.startAt || b.start) || a.id.localeCompare(b.id),
    );
    parent.scheduleCoverage = coverage;
    delete parent.startAt;
    delete parent.endAt;
    delete parent.seriesId;
    delete parent.occurrenceSamples;
    result.push(parent);
  }
  return result;
}

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
      hoursKnown: active.every((o) => !!o.time),
    };
  if ((event.scheduleCoverage || []).some((c) => c.complete && c.from <= date && c.to >= date))
    return { status: 'unavailable', date, intervals: [], reason: 'No scheduled availability' };
  return { status: 'unknown', date, intervals: [], reason: 'Schedule not confirmed for this date' };
}

/** Project cards without storing duplicated event details. @param {any} event @param {any} options */
export function projectEvent(event, { date, from, to, admin = false, savedIds = [] } = {}) {
  if (!admin && ['hidden', 'cancelled'].includes(event.status)) return [];
  const sessions = (event.occurrences || []).filter(
    (o) =>
      (admin || (!o.hidden && o.status === 'active')) &&
      (!from || o.end >= from) &&
      (!to || o.start <= to) &&
      (!date || (o.start <= date && o.end >= date)),
  );
  if (event.type !== 'Place' && event.recurring) {
    return sessions.map((o) => ({
      ...event,
      ...o.override,
      ...o,
      id: o.id,
      eventId: event.id,
      occurrenceId: o.id,
      start: o.start,
      end: o.end,
      time: o.time,
      url: o.url,
      recurring: true,
      schedule: 'event',
      status: o.hidden ? 'hidden' : o.status,
      ...(date ? { visitAvailability: availabilityOn(event, date) } : {}),
    }));
  }
  if (date) {
    const availability = availabilityOn(event, date);
    if (availability.status !== 'available') return [];
    return [{ ...event, visitAvailability: availability }];
  }
  if (from && to && !sessions.length) return [];
  return [event];
}
