// Intermediate extraction facts only. This module performs no fetching, expansion or writes.
import { z } from 'zod/v4';
import { collectionWindow, DEFAULT_TIME_ZONE, validScheduleDay } from '../event-schedule.mjs';

export const EXTRACTION_VERSION = '1';
export const EXTRACTION_LIMITS = Object.freeze({
  contextBytes: 131072,
  resultBytes: 262144,
  documents: 10,
  documentCharacters: 40000,
  documentUrls: 200,
  events: 50,
  dates: 200,
  rules: 24,
  exceptions: 100,
  images: 3,
  evidence: 40,
});
const text = (max) => z.string().min(1).max(max).regex(/\S/);
const url = z
  .string()
  .url()
  .max(2048)
  .regex(/^https:\/\/[^/?#@\s]+(?:[/?#][^\s]*)?$/);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const weekday = z.number().int().min(0).max(6); // Sunday = 0, as in VisitingSchedule.
const weekdays = z.array(weekday).min(1).max(7);
const pointer = z
  .string()
  .max(200)
  .regex(/^\/(?:[a-zA-Z][a-zA-Z0-9]*)(?:\/(?:[a-zA-Z][a-zA-Z0-9]*|\d+))*$/);

// null year means not printed; null day means month precision. Neither is a guessed date.
export const extractedDateSchema = z
  .strictObject({
    year: z.number().int().min(1900).max(2199).nullable(),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31).nullable(),
  })
  .describe(
    'Published date components: null year is omitted by source; null day is month precision.',
  );
const exactDate = extractedDateSchema.extend({ day: z.number().int().min(1).max(31) });
const timeFields = {
  startTime: clock.nullable(),
  endTime: clock.nullable(),
  endDayOffset: z.number().int().min(0).max(366).nullable(),
};
const interval = z.strictObject(timeFields);
const explicitDate = z.strictObject({
  start: exactDate,
  end: exactDate.nullable(),
  ...timeFields,
  status: z.enum(['active', 'cancelled']).nullable(),
});
const recurrence = z.strictObject({
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  interval: z.number().int().min(1).max(52),
  from: exactDate.nullable(),
  through: exactDate.nullable(),
  weekdays: weekdays.nullable(),
  monthDays: z.array(z.number().int().min(1).max(31)).min(1).max(31).nullable(),
  weekOfMonth: z
    .union([z.literal(-1), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
    .nullable(),
  ...timeFields,
});
const hours = z.strictObject({
  from: exactDate.nullable(),
  through: exactDate.nullable(),
  weekly: z
    .array(z.strictObject({ weekdays, ...timeFields }))
    .min(1)
    .max(21),
});
const exception = z.strictObject({
  from: exactDate,
  through: exactDate.nullable(),
  closed: z.boolean(),
  intervals: z.array(interval).min(1).max(12).nullable(),
});
const image = z.strictObject({
  url,
  kind: z.enum(['event', 'venue', 'artist', 'unknown']),
  caption: text(300).nullable(),
});
export const extractedEventSchema = z.strictObject({
  sourceUrl: url,
  title: text(300).nullable(),
  description: text(6000).nullable(),
  category: text(100).nullable(),
  status: z.enum(['active', 'cancelled']).nullable(),
  venue: z
    .strictObject({
      name: text(300).nullable(),
      address: text(600).nullable(),
      mode: z.enum(['in-person', 'online', 'hybrid']).nullable(),
    })
    .nullable(),
  price: z
    .strictObject({
      amount: z.number().min(0).max(1000000).nullable(),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .nullable(),
      text: text(1000).nullable(),
    })
    .nullable(),
  organizerUrl: url.nullable(),
  ticketUrl: url.nullable(),
  images: z.array(image).max(EXTRACTION_LIMITS.images).nullable(),
  schedule: z.strictObject({
    kind: z.enum(['single', 'multiple', 'recurring', 'exhibition']).nullable(),
    timeZone: text(100).nullable(),
    run: z
      .strictObject({
        from: extractedDateSchema.nullable(),
        through: extractedDateSchema.nullable(),
      })
      .nullable(),
    dates: z.array(explicitDate).max(EXTRACTION_LIMITS.dates).nullable(),
    recurrence: z.array(recurrence).max(EXTRACTION_LIMITS.rules).nullable(),
    hours: z.array(hours).max(EXTRACTION_LIMITS.rules).nullable(),
    exceptions: z.array(exception).max(EXTRACTION_LIMITS.exceptions).nullable(),
  }),
  evidence: z
    .array(
      z.strictObject({
        fields: z.array(pointer).min(1).max(30),
        sourceUrl: url,
        quote: text(600),
      }),
    )
    .min(1)
    .max(EXTRACTION_LIMITS.evidence),
  reviewReasons: z.array(z.strictObject({ field: pointer, reason: text(500) })).max(20),
});
export const eventExtractionSchema = z.strictObject({
  schemaVersion: z.literal(EXTRACTION_VERSION),
  events: z.array(extractedEventSchema).max(EXTRACTION_LIMITS.events),
});
export const extractionContextSchema = z.strictObject({
  schemaVersion: z.literal(EXTRACTION_VERSION),
  source: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  pageUrl: url,
  checkedAt: z.string().datetime({ offset: true }),
  timeZone: z.literal(DEFAULT_TIME_ZONE),
  window: z.strictObject({ from: day, to: day }),
  documents: z
    .array(
      z.strictObject({
        url,
        text: text(EXTRACTION_LIMITS.documentCharacters),
        urls: z.array(url).max(EXTRACTION_LIMITS.documentUrls),
      }),
    )
    .min(1)
    .max(EXTRACTION_LIMITS.documents),
});

// Structural constraints are exported for provider adapters; semantic checks below still apply.
export const eventExtractionJsonSchema = z.toJSONSchema(eventExtractionSchema, {
  target: 'draft-7',
});
export const extractionContextJsonSchema = z.toJSONSchema(extractionContextSchema, {
  target: 'draft-7',
});

const requireFact = (condition, path, message) => {
  if (!condition) throw Error(`Invalid extraction at ${path}: ${message}`);
};
function bounded(value, max) {
  requireFact(
    Buffer.byteLength(JSON.stringify(value) ?? '') <= max,
    '/',
    'JSON size limit exceeded',
  );
}
export function parseExtractionContext(value) {
  bounded(value, EXTRACTION_LIMITS.contextBytes);
  const context = extractionContextSchema.parse(value);
  const expected = collectionWindow(context.checkedAt);
  requireFact(
    context.window.from === expected.from && context.window.to === expected.to,
    '/window',
    'expected this and next Winnipeg month',
  );
  requireFact(
    context.documents.some((d) => d.url === context.pageUrl),
    '/documents',
    'page document missing',
  );
  requireFact(
    new Set(context.documents.map((d) => d.url)).size === context.documents.length,
    '/documents',
    'duplicate document URL',
  );
  return context;
}
const referenceYear = (context) =>
  Number(
    new Intl.DateTimeFormat('en', { timeZone: context.timeZone, year: 'numeric' }).format(
      new Date(context.checkedAt),
    ),
  );
function resolveDate(fact, year) {
  const prefix = `${fact.year ?? year}-${String(fact.month).padStart(2, '0')}`;
  const value = fact.day === null ? prefix : `${prefix}-${String(fact.day).padStart(2, '0')}`;
  requireFact(fact.day === null || validScheduleDay(value), '/date', 'invalid calendar date');
  return { value, precision: fact.day === null ? 'month' : 'day', yearAssumed: fact.year === null };
}
/** Resolve a missing year in application code, without altering the extracted facts. */
export function resolveExtractionDate(value, inputContext) {
  return extractionDateResolver(inputContext)(value);
}

/** Validate the context once when resolving many facts from the same extraction. */
export function extractionDateResolver(inputContext) {
  const year = referenceYear(parseExtractionContext(inputContext));
  return (value) => resolveDate(extractedDateSchema.parse(value), year);
}
const atPointer = (value, path) =>
  path
    .slice(1)
    .split('/')
    .reduce(
      (node, key) =>
        node !== null &&
        typeof node === 'object' &&
        (!Array.isArray(node) || /^(?:0|[1-9]\d*)$/.test(key)) &&
        Object.hasOwn(node, key)
          ? node[key]
          : undefined,
      value,
    );
const isFactPath = (event, path) =>
  !/^\/(?:evidence|reviewReasons)(?:\/|$)/.test(path) && atPointer(event, path) !== undefined;

export class MissingEndDayOffsetError extends Error {
  constructor() {
    super('Invalid extraction at /schedule: known end time needs explicit day offset');
  }
}

export function parseMainEventExtraction(value, context) {
  if (Array.isArray(value?.events) && value.events.length > 1)
    throw Error('Expected at most one main event');
  return parseEventExtraction(value, context);
}

/** Structural validity and evidence presence are not a factual accuracy or publication decision. */
export function parseEventExtraction(value, inputContext) {
  const context = parseExtractionContext(inputContext);
  bounded(value, EXTRACTION_LIMITS.resultBytes);
  const result = eventExtractionSchema.parse(value);
  const year = referenceYear(context);
  const publishedUrl = (u) => context.documents.some((d) => d.url === u || d.urls.includes(u));
  const checkRange = (from, through) => {
    const a = from && resolveDate(from, year),
      b = through && resolveDate(through, year);
    // Month precision cannot prove an exact ordering inside the same month.
    if (a && b)
      requireFact(
        b.value.slice(0, 7) >= a.value.slice(0, 7) &&
          (a.precision !== 'day' || b.precision !== 'day' || b.value >= a.value),
        '/schedule',
        'end precedes start',
      );
  };
  function checkTimes(slot, start = null, end = null) {
    requireFact(
      slot.endTime !== null || slot.endDayOffset === null,
      '/schedule',
      'unknown end time needs null day offset',
    );
    if (slot.endTime !== null && slot.endDayOffset === null) throw new MissingEndDayOffsetError();
    if (
      slot.startTime &&
      slot.endTime &&
      (!end || resolveDate(start, year).value === resolveDate(end, year).value)
    )
      requireFact(
        slot.endDayOffset > 0 || slot.endTime >= slot.startTime,
        '/schedule',
        'reversed local times need an overnight offset',
      );
    if (start && end && slot.endDayOffset !== null)
      requireFact(
        Date.parse(resolveDate(end, year).value) - Date.parse(resolveDate(start, year).value) ===
          slot.endDayOffset * 86400000,
        '/schedule',
        'end date disagrees with day offset',
      );
  }
  for (const event of result.events) {
    const schedule = event.schedule;
    requireFact(publishedUrl(event.sourceUrl), '/sourceUrl', 'URL not in supplied source material');
    for (const u of [
      event.organizerUrl,
      event.ticketUrl,
      ...(event.images || []).map((i) => i.url),
    ].filter(Boolean))
      requireFact(publishedUrl(u), '/url', 'URL not in supplied source material');
    if (schedule.timeZone) new Intl.DateTimeFormat('en', { timeZone: schedule.timeZone });
    if (schedule.run) checkRange(schedule.run.from, schedule.run.through);
    for (const date of schedule.dates || []) {
      checkRange(date.start, date.end);
      checkTimes(date, date.start, date.end);
    }
    for (const rule of schedule.recurrence || []) {
      checkRange(rule.from, rule.through);
      checkTimes(rule);
      requireFact(
        rule.frequency !== 'weekly' || rule.weekdays !== null,
        '/schedule/recurrence',
        'weekly days missing',
      );
      requireFact(
        rule.frequency === 'monthly' || (rule.monthDays === null && rule.weekOfMonth === null),
        '/schedule/recurrence',
        'monthly selector on non-monthly rule',
      );
      requireFact(
        rule.frequency !== 'daily' || rule.weekdays === null,
        '/schedule/recurrence',
        'daily rule cannot select weekdays',
      );
      if (rule.frequency === 'monthly')
        requireFact(
          (rule.monthDays !== null && rule.weekOfMonth === null && rule.weekdays === null) ||
            (rule.monthDays === null && rule.weekOfMonth !== null && rule.weekdays !== null),
          '/schedule/recurrence',
          'choose month days or ordinal weekdays',
        );
    }
    for (const period of schedule.hours || []) {
      checkRange(period.from, period.through);
      period.weekly.forEach((slot) => checkTimes(slot));
    }
    for (const exception of schedule.exceptions || []) {
      checkRange(exception.from, exception.through);
      requireFact(
        !exception.closed || exception.intervals === null,
        '/schedule/exceptions',
        'closed interval cannot have opening times',
      );
      exception.intervals?.forEach((slot) => checkTimes(slot));
    }
    for (const evidence of event.evidence) {
      const doc = context.documents.find((d) => d.url === evidence.sourceUrl);
      requireFact(
        doc?.text.includes(evidence.quote),
        '/evidence',
        'quote missing from supplied document',
      );
      for (const path of evidence.fields)
        requireFact(isFactPath(event, path), '/evidence/fields', 'unknown fact path');
    }
    for (const review of event.reviewReasons)
      requireFact(isFactPath(event, review.field), '/reviewReasons', 'unknown fact path');
    const supported = event.evidence.flatMap((e) => e.fields);
    function checkSupport(fact, path) {
      if (fact === null) return;
      if (typeof fact === 'object') {
        for (const [key, child] of Object.entries(fact)) checkSupport(child, path + '/' + key);
      } else
        requireFact(
          supported.some((p) => path === p || path.startsWith(p + '/')),
          path,
          'supporting evidence required',
        );
    }
    for (const [key, fact] of Object.entries(event))
      if (!['sourceUrl', 'evidence', 'reviewReasons'].includes(key)) checkSupport(fact, '/' + key);
  }
  return result;
}
