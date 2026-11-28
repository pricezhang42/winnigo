// Winnipeg local time from the checked-in table in lib/data/time-zone.mjs (npm run tz:update), so
// the server, the browser, tests and PostgreSQL never depend on the copy of the time zone database
// their runtime happens to bundle. Only America/Winnipeg is supported.
import { WINNIPEG_TIME_ZONE } from './data/time-zone.mjs';

export const TIME_ZONE = WINNIPEG_TIME_ZONE.zone;
const { initial, transitions } = WINNIPEG_TIME_ZONE;

const checkZone = (zone) => {
  if (zone !== undefined && zone !== TIME_ZONE) throw Error('Unsupported time zone: ' + zone);
};

/** Offset east of UTC, in milliseconds, at the instant `ms`. */
export function offsetAt(ms, zone) {
  checkZone(zone);
  const seconds = Math.floor(ms / 1000);
  let low = 0,
    high = transitions.length - 1,
    offset = initial;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (transitions[mid][0] <= seconds) {
      offset = transitions[mid][1];
      low = mid + 1;
    } else high = mid - 1;
  }
  return offset * 1000;
}

/** Local date ("2026-11-28") and 24-hour time ("20:00") in Winnipeg at an instant. */
export function localParts(instant, zone) {
  const ms = instant instanceof Date ? instant.getTime() : Date.parse(instant);
  if (!Number.isFinite(ms)) throw Error('Invalid instant');
  const local = new Date(ms + offsetAt(ms, zone)).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

/** "8:00 p.m." for an instant, in Winnipeg. */
export function clockLabel(instant, zone) {
  const [hours, minutes] = localParts(instant, zone).time.split(':').map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'a.m.' : 'p.m.'}`;
}

/** "8:00 p.m. – 10:00 p.m." (or just the start), empty without a start. */
export function timeLabel(startAt, endAt, zone) {
  if (!startAt) return endAt ? `Ends ${clockLabel(endAt, zone)}` : '';
  const start = clockLabel(startAt, zone);
  return endAt && Date.parse(endAt) > Date.parse(startAt)
    ? `${start} – ${clockLabel(endAt, zone)}`
    : start;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Nov 28, 8:00 p.m." (with `year`, "Nov 28, 2026, 8:00 p.m.") for an instant, in Winnipeg. */
export function dateTimeLabel(instant, { year = false } = {}) {
  const { date } = localParts(instant);
  const [y, m, d] = date.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}${year ? `, ${y}` : ''}, ${clockLabel(instant)}`;
}

/**
 * The zone name the job scheduler should use. While Winnipeg keeps one offset from now on (UTC−5
 * since 2026-11-01), it is the fixed-offset zone, which every copy of the time zone database
 * agrees on; with clock changes ahead it is the named zone, and the runtime's data decides.
 */
export function scheduleZone(now = Date.now()) {
  const ahead = transitions.some(([t]) => t * 1000 > now);
  const hours = -offsetAt(now) / 3600000;
  if (ahead || !Number.isInteger(hours)) return TIME_ZONE;
  return hours === 0 ? 'Etc/GMT' : `Etc/GMT${hours > 0 ? '+' : '-'}${Math.abs(hours)}`;
}

/**
 * The instant of a Winnipeg wall time. A time skipped by a clock change throws; one that occurs
 * twice resolves to the first occurrence, or throws with `rejectAmbiguous`.
 */
export function zonedInstant(day, time, zone, { rejectAmbiguous = false } = {}) {
  checkZone(zone);
  const wanted = Date.parse(`${day}T${time}:00Z`);
  if (!Number.isFinite(wanted)) throw Error('Invalid local schedule time');
  const matches = [];
  // Every offset in effect within a day either side is a candidate.
  for (const delta of [-86400000, 0, 86400000]) {
    const candidate = wanted - offsetAt(wanted + delta);
    if (candidate + offsetAt(candidate) === wanted && !matches.includes(candidate))
      matches.push(candidate);
  }
  if (!matches.length) throw Error('Local schedule time does not exist');
  if (matches.length > 1 && rejectAmbiguous) throw Error('Ambiguous local schedule time');
  return new Date(Math.min(...matches)).toISOString();
}
