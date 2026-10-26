// Bounded RFC 5545 ingestion. Never persist attendees, organizer identities or raw calendar data.
import * as ical from 'node-ical';
import { validScheduleDay, zonedTimestamp } from '../event-schedule.mjs';

const DAY = 86400000;
export const addCalendarDay = (day, count = 1) =>
  new Date(Date.parse(day + 'T12:00:00Z') + count * DAY).toISOString().slice(0, 10);
const calendarDay = (date) =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
const scalar = (value) => String(value?.val ?? value ?? '');
const keyOf = (date) => (date.dateOnly ? calendarDay(date) : date.toISOString());

/** Floating DATE-TIME values use the source's declared/default timezone, never the host zone. */
function explicitTimeZone(text, timeZone) {
  return text.replace(
    /^(DTSTART|DTEND|RECURRENCE-ID|EXDATE|RDATE)((?:;[^:\r\n]+)?):([^\r\n]+)$/gm,
    (line, name, params, value) => {
      if (
        /TZID=/i.test(params) ||
        /VALUE=DATE(?:;|$)/i.test(params) ||
        !/^\d{8}T\d{6}(?:,|$)/.test(value)
      )
        return line;
      return `${name}${params};TZID=${timeZone}:${value}`;
    },
  );
}

function rdateEvents(event, timeZone) {
  const dates = [];
  for (const property of [event.rdate].flat().filter(Boolean)) {
    const params = property.params || {};
    for (const value of scalar(property).split(',')) {
      const [start, end] = value.split('/');
      const dateOnly = params.VALUE === 'DATE' || /^\d{8}$/.test(start);
      const suffix = dateOnly
        ? ';VALUE=DATE'
        : start.endsWith('Z')
          ? ''
          : `;TZID=${params.TZID || timeZone}`;
      const parsed = ical.sync.parseICS(
        `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:rdate\r\nDTSTART${suffix}:${start}\r\n${end ? (end.startsWith('P') ? `DURATION:${end}` : `DTEND${suffix}:${end}`) + '\r\n' : ''}END:VEVENT\r\nEND:VCALENDAR`,
      ).rdate;
      if (!(parsed?.start instanceof Date) || !Number.isFinite(+parsed.start))
        throw Error('Invalid RDATE');
      dates.push({
        ...event,
        rrule: undefined,
        rdate: undefined,
        start: parsed.start,
        end: end ? parsed.end : new Date(+parsed.start + (+event.end - +event.start)),
        datetype: dateOnly ? 'date' : 'date-time',
      });
    }
  }
  return dates;
}

/** Returns source-neutral events with lightweight occurrences, plus safely withheld UID groups. */
export function parseIcsEvents(
  text,
  { from, to, timeZone = 'America/Winnipeg', maxOccurrences = 5000 } = {},
) {
  if (
    !validScheduleDay(from) ||
    !validScheduleDay(to) ||
    to < from ||
    Date.parse(to) - Date.parse(from) > 93 * DAY
  )
    throw Error('Invalid bounded ICS horizon');
  text = String(text)
    .replace(/\r?\n[ \t]/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (
    !text.startsWith('BEGIN:VCALENDAR\n') ||
    !text.endsWith('END:VCALENDAR') ||
    (text.match(/^BEGIN:VEVENT$/gm) || []).length !== (text.match(/^END:VEVENT$/gm) || []).length
  )
    throw Error('Incomplete or invalid ICS calendar');
  const count = (text.match(/^BEGIN:VEVENT$/gm) || []).length;
  if (count > 10000) throw Error('ICS event limit exceeded');
  const floatingTimeZone = text.match(/^X-WR-TIMEZONE:(.+)$/m)?.[1].trim() || timeZone;
  new Intl.DateTimeFormat('en', { timeZone: floatingTimeZone });
  const dayAt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // Refuse custom/unrecognized zones rather than letting a parser silently reinterpret them.
  for (const match of text.matchAll(/(?:^|;)TZID=([^:;\n]+)/gm))
    new Intl.DateTimeFormat('en', { timeZone: match[1].replace(/^"|"$/g, '') });
  if (/^RECURRENCE-ID;[^\n]*RANGE=/m.test(text) || /^EXRULE:/m.test(text))
    throw Error('Unsupported ICS recurrence range or EXRULE');
  const parsed = ical.sync.parseICS(explicitTimeZone(text, floatingTimeZone));
  const roots = Object.values(parsed).filter((e) => e.type === 'VEVENT');
  if (count && !roots.length) throw Error('No parsed ICS events');
  const events = [],
    rejected = [];
  const fromInstant = new Date(zonedTimestamp(from, '00:00', timeZone)),
    endExclusive = new Date(zonedTimestamp(addCalendarDay(to), '00:00', timeZone));
  let total = 0;
  for (const event of roots) {
    try {
      const extraDates = rdateEvents(event, floatingTimeZone);
      if (!event.rrule) {
        const dates = [event, ...extraDates, ...Object.values(event.recurrences || {})];
        if (
          dates.every(
            (e) =>
              e.start instanceof Date &&
              Number.isFinite(+e.start) &&
              (+e.start >= +endExclusive || Math.max(+e.start, +e.end || 0) < +fromInstant),
          )
        )
          continue;
      }
      // Historical feed defects outside the requested horizon must not poison this window.
      // Never skip a master with RDATE/overrides, which can move an old series into the window.
      if (
        event.start instanceof Date &&
        Number.isFinite(+event.start) &&
        [...extraDates, ...Object.values(event.recurrences || {})].every(
          (e) =>
            e.start instanceof Date &&
            (+e.start >= +endExclusive || Math.max(+e.start, +e.end || 0) < +fromInstant),
        )
      ) {
        const last = event.rrule?.options.until;
        const duration = Math.max(0, +event.end - +event.start) || 0;
        if (
          (!event.rrule &&
            (+event.start >= +endExclusive ||
              Math.max(+event.start, +event.end || 0) < +fromInstant)) ||
          (last instanceof Date && +last + duration < +fromInstant)
        )
          continue;
      }
      if (
        !event.uid ||
        !scalar(event.summary).trim() ||
        !(event.start instanceof Date) ||
        !Number.isFinite(+event.start) ||
        !(event.end instanceof Date) ||
        !Number.isFinite(+event.end) ||
        event.end < event.start
      )
        throw Error('Incomplete ICS event');
      const rule = event.rrule?.toString() || '';
      if (/FREQ=(SECONDLY|MINUTELY)|BYSECOND=|BYMINUTE=[^;\n]*,/i.test(rule))
        throw Error('ICS recurrence exceeds supported density');
      const options = {
        from: new Date(+fromInstant - DAY),
        to: new Date(+endExclusive + DAY),
        expandOngoing: true,
        excludeExdates: false,
      };
      const instances = ical.expandRecurringEvent(event, options);
      for (const extra of extraDates) {
        const override = event.recurrences?.[keyOf(extra.start)];
        const effective = override ? { ...extra, ...override, rrule: undefined } : extra;
        for (const instance of ical.expandRecurringEvent(effective, options))
          instances.push({
            ...instance,
            isRecurring: true,
            isOverride: !!override,
            recurrenceKey: keyOf(extra.start),
          });
      }
      const occurrences = new Map();
      for (const instance of instances) {
        const start = instance.isFullDay
          ? calendarDay(instance.start)
          : dayAt.format(instance.start);
        // DATE DTEND is exclusive; no midnight timestamp is invented for date-only events.
        const end = instance.isFullDay
          ? addCalendarDay(calendarDay(instance.end), -1)
          : dayAt.format(instance.end);
        if (
          end < from ||
          start > to ||
          (!instance.isFullDay && +instance.end <= +fromInstant && +instance.start < +fromInstant)
        )
          continue;
        const recurrenceKey =
          instance.recurrenceKey ||
          (instance.isOverride ? keyOf(instance.event.recurrenceid) : keyOf(instance.start));
        const effective = { ...event, ...instance.event };
        const excluded = Object.values(event.exdate || {}).some(
          (d) => d instanceof Date && keyOf(d) === recurrenceKey,
        );
        const durationKnown = instance.isFullDay || +effective.end > +effective.start;
        const format = (d) =>
          d.toLocaleTimeString('en-CA', { timeZone, hour: 'numeric', minute: '2-digit' });
        occurrences.set(recurrenceKey, {
          recurrenceKey,
          start,
          end,
          ...(!instance.isFullDay
            ? { startAt: instance.start.toISOString(), endAt: instance.end.toISOString() }
            : {}),
          time: instance.isFullDay
            ? 'All day'
            : format(instance.start) + (durationKnown ? ' – ' + format(instance.end) : ''),
          timeZone,
          status:
            excluded ||
            scalar(event.status) === 'CANCELLED' ||
            scalar(effective.status) === 'CANCELLED'
              ? 'cancelled'
              : 'active',
          title: scalar(instance.summary || event.summary),
          url: scalar(effective.url || event.url),
          description: scalar(effective.description),
          location: scalar(effective.location),
          durationKnown,
        });
      }
      total += occurrences.size;
      if (total > maxOccurrences) throw Error('ICS occurrence limit exceeded');
      if (occurrences.size)
        events.push({
          uid: event.uid,
          title: scalar(event.summary),
          url: scalar(event.url),
          description: scalar(event.description),
          location: scalar(event.location),
          recurring: !!(event.rrule || event.rdate || event.recurrenceid),
          status: scalar(event.status) === 'CANCELLED' ? 'cancelled' : 'active',
          occurrences: [...occurrences.values()],
        });
    } catch (error) {
      if (error.message === 'ICS occurrence limit exceeded') throw error;
      rejected.push({ uid: scalar(event.uid), error: error.message });
    }
  }
  return { events, rejected, eventCount: count, occurrencesFound: total, from, to };
}
