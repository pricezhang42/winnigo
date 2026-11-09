import {
  materializeVisitingHours,
  normalizeOccurrence,
  zonedTimestamp,
} from '../event-schedule.mjs';

const DAY = 86400000;
const timestamp = (day) => Date.parse(day + 'T00:00:00Z');
const shift = (day, delta) => new Date(timestamp(day) + delta * DAY).toISOString().slice(0, 10);
const weekday = (day) => new Date(timestamp(day)).getUTCDay();
const monthIndex = (day) => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7));
const exact = { rejectAmbiguous: true };
const within = (day, from, through) => (!from || day >= from) && (!through || day <= through);
export const occurrenceSlot = (o) => o.startAt || o.start;

function matchesRule(rule, day, from) {
  const offset = from ? (timestamp(day) - timestamp(from)) / DAY : 0;
  if (rule.frequency === 'daily') return offset % rule.interval === 0;
  if (rule.frequency === 'weekly')
    return (
      rule.weekdays.includes(weekday(day)) &&
      Math.floor((offset + (from ? weekday(from) : 0)) / 7) % rule.interval === 0
    );
  if (from && (monthIndex(day) - monthIndex(from)) % rule.interval) return false;
  const date = Number(day.slice(-2));
  return rule.monthDays
    ? rule.monthDays.includes(date)
    : rule.weekdays.includes(weekday(day)) &&
        (rule.weekOfMonth === -1
          ? monthIndex(shift(day, 7)) !== monthIndex(day)
          : Math.ceil(date / 7) === rule.weekOfMonth);
}

/** Convert validated schedule facts into shared occurrence rows; never infer coverage. */
export function mapExtractedSchedule(event, parent, context, resolveDate) {
  let yearAssumed = false;
  const resolve = (fact) => {
    if (!fact) return null;
    const value = resolveDate(fact);
    yearAssumed ||= value.yearAssumed;
    return value;
  };
  const day = (fact) => resolve(fact)?.value ?? null;
  const s = event.schedule,
    window = context.window,
    zone = s.timeZone || context.timeZone;
  const from = resolve(s.run?.from),
    through = resolve(s.run?.through);
  const runDates = {
    ...(from?.precision === 'day' ? { start: from.value } : {}),
    ...(through ? { [through.precision === 'month' ? 'endMonth' : 'end']: through.value } : {}),
  };
  const inRun = (d) =>
    (!from || d.slice(0, from.value.length) >= from.value) &&
    (!through || d.slice(0, through.value.length) <= through.value);
  const boundaryUnknown = (d) =>
    [from, through].some((bound) => bound?.precision === 'month' && d.startsWith(bound.value));
  const exceptions = (s.exceptions || []).map((e) => {
    const date = day(e.from);
    return { from: date, to: day(e.through) || date, closed: e.closed, intervals: e.intervals };
  });
  const duration = (e) => timestamp(e.to) - timestamp(e.from);
  const closed = (d) => {
    const matches = exceptions
      .filter((e) => within(d, e.from, e.to))
      .sort((a, b) => duration(a) - duration(b));
    if (
      matches[1] &&
      duration(matches[0]) === duration(matches[1]) &&
      matches[0].closed !== matches[1].closed
    )
      throw Error('conflicting-exceptions');
    return matches[0]?.closed;
  };
  const slots = new Map();
  function add(row, explicit = false) {
    if (row.end < window.from || row.start > window.to) return;
    const key = occurrenceSlot(row),
      old = slots.get(key);
    if (old && old.explicit === explicit && JSON.stringify(old.row) !== JSON.stringify(row))
      throw Error('conflicting-occurrence');
    if (!old?.explicit || explicit) slots.set(key, { row, explicit });
    if (slots.size > 1500) throw Error('occurrence-limit');
  }
  function occurrence(fact, start, end, basis) {
    // The repository stores timestamps as a pair. A multi-day interval with an
    // unknown boundary time stays date-only, with its published clock text retained.
    const timed = fact.startTime && (fact.endTime || start === end);
    return normalizeOccurrence(
      {
        start,
        end,
        timeZone: zone,
        basis,
        status: event.status === 'cancelled' ? 'cancelled' : fact.status || 'active',
        ...(timed
          ? {
              startAt: zonedTimestamp(start, fact.startTime, zone, exact),
              ...(fact.endTime ? { endAt: zonedTimestamp(end, fact.endTime, zone, exact) } : {}),
            }
          : {
              time: [
                fact.startTime && `Starts ${fact.startTime}`,
                fact.endTime && `Ends ${fact.endTime}`,
              ]
                .filter(Boolean)
                .join(' · '),
            }),
        endTimeKnown: Boolean(fact.endTime),
      },
      parent,
    );
  }

  if (s.recurrence?.length && (s.hours?.length || exceptions.some((e) => !e.closed)))
    throw Error('mixed-recurrence-and-visiting-hours');
  for (const rule of s.recurrence || []) {
    const anchor = day(rule.from),
      last = day(rule.through);
    if (rule.interval > 1 && !anchor) throw Error('missing-recurrence-anchor');
    for (
      let d = shift(window.from, -(rule.endDayOffset || 0) - 1);
      d <= shift(window.to, 1);
      d = shift(d, 1)
    ) {
      if (!within(d, anchor, last) || !inRun(d) || closed(d) || !matchesRule(rule, d, anchor))
        continue;
      const row = occurrence(rule, d, shift(d, rule.endDayOffset || 0), 'calendar');
      if (row.end >= window.from && row.start <= window.to && boundaryUnknown(d))
        throw Error('imprecise-run-boundary');
      add(row);
    }
  }

  if (s.hours?.length || exceptions.some((e) => !e.closed)) {
    const timeRange = (slot) => {
      if (
        !slot.startTime ||
        !slot.endTime ||
        slot.endDayOffset !== Number(slot.endTime <= slot.startTime)
      )
        throw Error('unconfirmed-visiting-hours');
      return { opens: slot.startTime, closes: slot.endTime };
    };
    const periods = (s.hours || []).map((period) => {
      const start = day(period.from) || runDates.start,
        end = day(period.through) || runDates.end;
      if (!start || !end) throw Error('unconfirmed-visiting-hours-bounds');
      return {
        from: start,
        to: end,
        weekly: period.weekly.map((slot) => ({ weekdays: slot.weekdays, ...timeRange(slot) })),
      };
    });
    const overrides = exceptions.map((e) => {
      if (!e.closed && !e.intervals) throw Error('unconfirmed-exception-hours');
      return { ...e, intervals: (e.intervals || []).map(timeRange) };
    });
    const { occurrences } = materializeVisitingHours(
      {
        timeZone: zone,
        sourceUrl: parent.url,
        checkedAt: context.checkedAt,
        periods,
        exceptions: overrides,
      },
      { ...parent, start: runDates.start, end: runDates.end, endMonth: runDates.endMonth },
      window,
      exact,
    );
    for (const row of occurrences) {
      if (!inRun(row.start) || boundaryUnknown(row.start)) throw Error('imprecise-run-boundary');
      add(event.status === 'cancelled' ? { ...row, status: 'cancelled' } : row);
    }
  }

  for (const fact of s.dates || []) {
    const start = day(fact.start),
      end = day(fact.end) || shift(start, fact.endDayOffset || 0);
    if (
      fact.status !== 'cancelled' &&
      event.status !== 'cancelled' &&
      (closed(start) || !inRun(start) || !inRun(end))
    )
      throw Error('conflicting-explicit-date');
    const row = occurrence(fact, start, end, 'event');
    // A date-only exhibition entry adds no second card when visiting hours
    // already give a more precise interval for that day.
    if (
      s.kind === 'exhibition' &&
      !row.startAt &&
      row.status !== 'cancelled' &&
      [...slots.values()].some((slot) => slot.row.start === row.start && slot.row.startAt)
    )
      continue;
    add(row, true);
  }
  const occurrences = [...slots.values()]
    .map(({ row }) => row)
    .sort((a, b) => occurrenceSlot(a).localeCompare(occurrenceSlot(b)));
  const timedDays = new Set(occurrences.filter((o) => o.startAt).map((o) => o.start));
  if (occurrences.some((o) => !o.startAt && timedDays.has(o.start)))
    throw Error('ambiguous-date-only-occurrence');
  if (
    s.kind === 'exhibition' &&
    new Set(occurrences.map((o) => o.start)).size !== occurrences.length
  )
    throw Error('multiple-exhibition-intervals');
  return { occurrences, runDates, yearAssumed };
}
