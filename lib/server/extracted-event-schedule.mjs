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

export class ScheduleReviewError extends Error {}

function classWindow(schedule, window, day) {
  const days = (schedule.dates || []).flatMap((date) => [day(date.start), day(date.end)]);
  for (const rule of schedule.recurrence || []) {
    const from = day(rule.from || schedule.run?.from);
    const through = day(rule.through || schedule.run?.through);
    if (!from || !through || from.length !== 10 || through.length !== 10)
      throw new ScheduleReviewError('unconfirmed-class-dates');
    days.push(from, through);
  }
  const sorted = days.filter(Boolean).sort();
  const from = sorted[0],
    to = sorted.at(-1);
  if (!from || timestamp(to) - timestamp(from) > 366 * DAY || schedule.hours?.length)
    throw new ScheduleReviewError('unconfirmed-class-dates');
  return to < window.from || from > window.to ? window : { from, to };
}

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
    window = event.registration === 'series' ? classWindow(s, context.window, day) : context.window,
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
      throw new ScheduleReviewError('conflicting-exceptions');
    return matches[0]?.closed;
  };
  const slots = new Map();
  function add(row, explicit = false) {
    if (row.end < window.from || row.start > window.to) return;
    const key = occurrenceSlot(row),
      old = slots.get(key);
    if (old && old.explicit === explicit && JSON.stringify(old.row) !== JSON.stringify(row))
      throw new ScheduleReviewError('conflicting-occurrence');
    if (!old?.explicit || explicit) slots.set(key, { row, explicit });
    if (slots.size > 1500) throw new ScheduleReviewError('occurrence-limit');
  }
  function occurrence(fact, start, end, basis) {
    const startAt = fact.startTime ? zonedTimestamp(start, fact.startTime, zone, exact) : undefined;
    const endAt = fact.endTime ? zonedTimestamp(end, fact.endTime, zone, exact) : undefined;
    if (startAt && endAt && endAt < startAt) throw new ScheduleReviewError('invalid-time-range');
    const row = normalizeOccurrence(
      {
        start,
        end,
        timeZone: zone,
        basis,
        status: event.status === 'cancelled' ? 'cancelled' : fact.status || 'active',
        ...(startAt && endAt ? { startAt, endAt } : {}),
        endTimeKnown: Boolean(fact.endTime),
      },
      parent,
    );
    return { ...row, startAt, endAt };
  }

  const hasVisitingHours = s.hours?.length || exceptions.some((e) => !e.closed);
  if (s.recurrence?.length && hasVisitingHours)
    throw new ScheduleReviewError('mixed-recurrence-and-visiting-hours');
  for (const rule of s.recurrence || []) {
    const anchor = day(rule.from),
      last = day(rule.through);
    if (rule.interval > 1 && !anchor) throw new ScheduleReviewError('missing-recurrence-anchor');
    for (
      let d = shift(window.from, -(rule.endDayOffset || 0) - 1);
      d <= shift(window.to, 1);
      d = shift(d, 1)
    ) {
      if (!within(d, anchor, last) || !inRun(d) || closed(d) || !matchesRule(rule, d, anchor))
        continue;
      const row = occurrence(rule, d, shift(d, rule.endDayOffset || 0), 'calendar');
      if (row.end >= window.from && row.start <= window.to && boundaryUnknown(d))
        throw new ScheduleReviewError('imprecise-run-boundary');
      add(row);
    }
  }

  if (hasVisitingHours) {
    const timeRange = (slot) => {
      if (
        !slot.startTime ||
        !slot.endTime ||
        slot.endDayOffset !== Number(slot.endTime <= slot.startTime)
      )
        throw new ScheduleReviewError('unconfirmed-visiting-hours');
      return { opens: slot.startTime, closes: slot.endTime };
    };
    const periods = (s.hours || []).map((period) => {
      const start = day(period.from) || runDates.start,
        end = day(period.through) || runDates.end;
      if (!start || !end) throw new ScheduleReviewError('unconfirmed-visiting-hours-bounds');
      return {
        from: start,
        to: end,
        weekly: period.weekly.map((slot) => ({ weekdays: slot.weekdays, ...timeRange(slot) })),
      };
    });
    const overrides = exceptions.map((e) => {
      if (!e.closed && !e.intervals) throw new ScheduleReviewError('unconfirmed-exception-hours');
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
      if (!inRun(row.start) || boundaryUnknown(row.start))
        throw new ScheduleReviewError('imprecise-run-boundary');
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
      throw new ScheduleReviewError('conflicting-explicit-date');
    const row = occurrence(fact, start, end, 'event');
    // A date-only entry adds no second card when a rule or visiting hours already
    // give a more precise interval for that day (for example listed dates of a
    // "second Sunday, 11am-5pm" program).
    if (
      !row.startAt &&
      row.status !== 'cancelled' &&
      [...slots.values()].some(
        (slot) => !slot.explicit && slot.row.start === row.start && slot.row.startAt,
      )
    )
      continue;
    add(row, true);
  }
  const occurrences = [...slots.values()]
    .map(({ row }) => row)
    .sort((a, b) => occurrenceSlot(a).localeCompare(occurrenceSlot(b)));
  const timedDays = new Set(occurrences.filter((o) => o.startAt).map((o) => o.start));
  if (occurrences.some((o) => !o.startAt && timedDays.has(o.start)))
    throw new ScheduleReviewError('ambiguous-date-only-occurrence');
  if (
    s.kind === 'exhibition' &&
    new Set(occurrences.map((o) => o.start)).size !== occurrences.length
  )
    throw new ScheduleReviewError('multiple-exhibition-intervals');
  return { occurrences, runDates, yearAssumed };
}
