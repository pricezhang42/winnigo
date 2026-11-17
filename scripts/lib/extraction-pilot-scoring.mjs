import { resolveExtractionDate } from '../../lib/contracts/event-extraction.mjs';

const ordered = (values) => [...new Set(values)].sort();
const normalized = (value) =>
  typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim() : value;

export function modelFacts(event, context) {
  if (!event) return null;
  const schedule = event.schedule;
  const date = (fact) => fact && resolveExtractionDate(fact, context).value;
  const slots = (schedule.dates || []).map((row) => ({ ...row, day: date(row.start) }));
  slots.sort(
    (a, b) => a.day.localeCompare(b.day) || (a.startTime || '').localeCompare(b.startTime || ''),
  );
  const first = slots[0];
  const last = slots.at(-1);
  const recurrence = schedule.recurrence?.[0];
  // Multiple open-date blocks belong to one event. Score the complete published bounds,
  // not just the first block; leave an unbounded rule's overall boundary unknown.
  const ruleBounds = (field) => {
    const rules = schedule.recurrence || [];
    return rules.length && rules.every((rule) => rule[field])
      ? ordered(rules.map((rule) => date(rule[field])))
      : [];
  };
  // An untimed date takes its time from the rule or visiting hours, as the mapper publishes it.
  const timing =
    (first?.startTime ? first : null) ?? recurrence ?? schedule.hours?.[0]?.weekly[0] ?? first;
  const offsetEnd =
    last?.endDayOffset > 0
      ? new Date(Date.parse(last.day) + last.endDayOffset * 86400000).toISOString().slice(0, 10)
      : null;
  return {
    title: event.title,
    price: event.price?.amount ?? null,
    availability: event.availability ?? 'unknown',
    venue: event.venue?.name ?? (event.venue?.mode === 'online' ? 'Online' : null),
    sourceUrl: event.sourceUrl,
    date: date(schedule.run?.from) || ruleBounds('from')[0] || first?.day || null,
    endDate:
      date(schedule.run?.through) ||
      ruleBounds('through').at(-1) ||
      date(last?.end) ||
      offsetEnd ||
      (last?.day !== first?.day ? last.day : null),
    startTime: timing?.startTime ?? null,
    endTime: timing?.endTime ?? null,
    dates: ordered(slots.map((row) => row.day)),
    showtimes: slots.filter((row) => row.startTime).map((row) => row.day + ' ' + row.startTime),
    recurring: Boolean(schedule.recurrence?.length || schedule.run || slots.length > 1),
    closedDates: ordered(
      (schedule.exceptions || []).filter((row) => row.closed).map((row) => date(row.from)),
    ),
    openWeekdays: ordered([
      ...(schedule.hours || []).flatMap((period) => period.weekly.flatMap((row) => row.weekdays)),
      ...(schedule.recurrence || [])
        .filter((rule) => rule.frequency === 'weekly')
        .flatMap((rule) => rule.weekdays || []),
    ]),
    imageUrls: (event.images || []).map((image) => image.url),
    review: event.reviewReasons.length > 0,
  };
}

export function score(expected, actual) {
  const matches = ([field, value]) => {
    if (!actual) return false;
    if (field === 'imageUrl') {
      const images = actual.imageUrls || [];
      return value === null ? images.length === 0 : images.includes(value);
    }
    if (Array.isArray(value))
      return (
        Array.isArray(actual[field]) &&
        JSON.stringify(ordered(value)) === JSON.stringify(ordered(actual[field]))
      );
    // Terminal sentence punctuation does not change a venue's identity.
    const text = (v) =>
      field === 'venue' && typeof v === 'string'
        ? normalized(v).replace(/[.]$/, '')
        : normalized(v);
    return text(value) === text(actual[field]);
  };
  return {
    missing: expected !== null && actual === null,
    extra: expected === null && actual !== null,
    fields: Object.fromEntries(
      Object.entries(expected || {}).map((entry) => [entry[0], matches(entry)]),
    ),
  };
}
