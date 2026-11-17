import { extractionDateResolver } from '../contracts/event-extraction.mjs';
import { mapExtractedSchedule } from './extracted-event-schedule.mjs';

const sameDays = (a, b) => a.start === b.start && a.end === b.end;

// The collector owns dates, closures, IDs and verified run bounds. Model schedules
// supply optional clock refinements, never extra visiting days or opening dates.
export function applyCalendarEnrichment(item, event, calendar, old, context) {
  let proposals = [];
  const notes = [];
  try {
    proposals = mapExtractedSchedule(
      { ...event, schedule: { ...event.schedule, run: null } },
      item,
      context,
      extractionDateResolver(context),
    ).occurrences.filter((row) => row.startAt && row.start === row.end);
  } catch (error) {
    notes.push(error.message);
  }
  item.occurrences = preserveCalendarTimes(calendar.occurrences, old?.occurrences).map((base) => {
    const row = calendar.occurrences.find((r) => sameDays(r, base));
    const status = base.status;
    const choices = proposals.filter((p) => sameDays(p, row) && p.status === row.status);
    if (base.startAt) {
      if (
        choices.some(
          (p) =>
            p.startAt !== base.startAt ||
            (p.endTimeKnown !== false && base.endTimeKnown !== false && p.endAt !== base.endAt),
        )
      )
        notes.push(
          `${row.start}: extracted time conflicts with a saved showtime; saved timing retained`,
        );
      return { ...base, status };
    }
    if (status !== 'active' || !choices.length) return { ...base, status };
    if (choices.length !== 1) {
      notes.push(`${row.start}: multiple extracted times; calendar timing retained`);
      return { ...base, status };
    }
    return { ...choices[0], id: base.id, url: row.url, basis: row.basis, status };
  });
  delete item.runDates;
  if (calendar.runDates) item.runDates = structuredClone(calendar.runDates);
  item.recurring = Boolean(
    calendar.recurring || old?.recurring || item.runDates || item.occurrences.length > 1,
  );
  item.schedule = item.recurring ? 'series' : 'event';
  item.time = item.recurring ? '' : item.occurrences[0].time;
  if (!item.recurring) ({ start: item.start, end: item.end } = item.occurrences[0]);
  item.status = calendar.status || old?.status || 'active';
  item.occurrencesComplete = calendar.occurrencesComplete === true;
  item.scheduleCoverage = structuredClone(calendar.scheduleCoverage || []);
  item.sourceLinks = [...new Set([...(old?.sourceLinks || []), ...(calendar.sourceLinks || [])])];
  if (calendar.officialUrl) item.officialUrl = calendar.officialUrl;
  if (calendar.reviewReason) item.reviewReason = calendar.reviewReason;
  else delete item.reviewReason;
  item.extraction.scheduleAuthority = 'calendar';
  item.extraction.scheduleReview = event.reviewReasons.filter((r) =>
    r.field.startsWith('/schedule'),
  );
  item.extraction.timingReview = [...new Set(notes)];
}

// A date-only feed must not erase previously verified showtimes on AI failure,
// cache misses, or a later parser-only collection. Calendar cancellations still win.
export function preserveCalendarTimes(rows, previous = []) {
  return rows.flatMap((row) => {
    const timed = previous.filter(
      (old) => sameDays(old, row) && old.startAt && old.status !== 'superseded',
    );
    return (!row.startAt && timed.length ? timed : [row]).map((base) => ({
      ...base,
      status:
        row.status === 'cancelled'
          ? 'cancelled'
          : previous.find(
              (old) =>
                old.id === base.id &&
                !old.duplicateOf &&
                ['cancelled', 'superseded'].includes(old.status),
            )?.status || base.status,
    }));
  });
}
