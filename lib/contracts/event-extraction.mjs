// Intermediate extraction facts only. This module performs no fetching, expansion or writes.
import { z } from 'zod/v4';
import { collectionWindow, DEFAULT_TIME_ZONE, validScheduleDay } from '../event-schedule.mjs';

// The prepared input format and the model output format are versioned separately.
export const CONTEXT_VERSION = '1';
export const EXTRACTION_VERSION = '2';
export const EXTRACTION_LIMITS = Object.freeze({
  contextBytes: 131072,
  resultBytes: 262144,
  documents: 10,
  documentCharacters: 40000,
  documentUrls: 200,
  dates: 200,
  rules: 24,
  exceptions: 100,
  images: 3,
  quote: 600,
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
const quote = text(EXTRACTION_LIMITS.quote).describe(
  'The shortest exact excerpt from a document text that supports this entry.',
);
const times = { startTime: clock.nullable(), endTime: clock.nullable() };
const interval = z.strictObject(times);

// What the model returns. Facts Winnigo already knows (source URL, timezone, IDs,
// schema version) and facts it can derive (day offsets, schedule kind, overall
// status, category, currency, description) are deliberately absent.
const modelDate = z.strictObject({
  start: exactDate,
  end: exactDate.nullable(),
  ...times,
  cancelled: z.boolean(),
  quote,
});
const modelRecurrence = z.strictObject({
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  interval: z.number().int().min(1).max(52),
  from: exactDate.nullable(),
  through: exactDate.nullable(),
  weekdays: weekdays.nullable(),
  monthDays: z.array(z.number().int().min(1).max(31)).min(1).max(31).nullable(),
  weekOfMonth: z
    .union([z.literal(-1), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
    .nullable(),
  ...times,
  quote,
});
const modelHours = z.strictObject({
  from: exactDate.nullable(),
  through: exactDate.nullable(),
  weekly: z
    .array(z.strictObject({ weekdays, ...times }))
    .min(1)
    .max(21),
  quote,
});
const modelException = z.strictObject({
  from: exactDate,
  through: exactDate.nullable(),
  closed: z.boolean(),
  intervals: z.array(interval).min(1).max(12).nullable(),
  quote,
});
export const modelEventSchema = z.strictObject({
  title: text(300).nullable(),
  titleQuote: quote.nullable(),
  venue: z
    .strictObject({
      name: text(300).nullable(),
      address: text(600).nullable(),
      online: z.boolean(),
      quote,
    })
    .nullable(),
  price: z
    .strictObject({
      amount: z.number().min(0).max(1000000).nullable(),
      text: text(1000).nullable(),
      quote,
    })
    .nullable(),
  ticketUrl: url.nullable(),
  organizerUrl: url.nullable(),
  imageUrls: z.array(url).max(EXTRACTION_LIMITS.images),
  schedule: z.strictObject({
    run: z
      .strictObject({
        from: extractedDateSchema.nullable(),
        through: extractedDateSchema.nullable(),
        quote,
      })
      .nullable(),
    dates: z.array(modelDate).max(EXTRACTION_LIMITS.dates),
    recurrence: z.array(modelRecurrence).max(EXTRACTION_LIMITS.rules),
    hours: z.array(modelHours).max(EXTRACTION_LIMITS.rules),
    exceptions: z.array(modelException).max(EXTRACTION_LIMITS.exceptions),
  }),
  reviewReasons: z.array(text(500)).max(20),
});
export const eventExtractionSchema = z.strictObject({ event: modelEventSchema.nullable() });
export const extractionContextSchema = z.strictObject({
  schemaVersion: z.literal(CONTEXT_VERSION),
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

// Quotes are compared after Unicode and whitespace normalization only.
const comparable = (value) => value.normalize('NFKC').replace(/\s+/g, ' ').trim();
const DAY = 86400000;
// A known end time earlier than (or equal to) the start time closes on the next day.
const overnight = (slot) =>
  slot.endTime === null ? null : slot.startTime && slot.endTime <= slot.startTime ? 1 : 0;

/**
 * Validate the model output against the prepared context and convert it to the
 * internal event shape used by the mapper. Unsupported optional facts become
 * unknown; unsupported or invalid core facts (title, schedule entries) are
 * dropped and recorded in reviewReasons so the event is held for review.
 * Structural schema failures still throw.
 */
export function parseEventExtraction(value, inputContext) {
  const context = parseExtractionContext(inputContext);
  bounded(value, EXTRACTION_LIMITS.resultBytes);
  const { event } = eventExtractionSchema.parse(value);
  const output = { schemaVersion: EXTRACTION_VERSION, events: [], issues: [] };
  if (!event) return output;

  const year = referenceYear(context);
  const texts = context.documents.map((d) => ({ url: d.url, text: comparable(d.text) }));
  const findQuote = (q) => q && texts.find((d) => d.text.includes(comparable(q)))?.url;
  const published = (u) => context.documents.some((d) => d.url === u || d.urls.includes(u));
  const review = event.reviewReasons.map((reason) => ({ field: '/', reason }));
  const evidence = [];
  const supported = (q, field) => {
    const sourceUrl = findQuote(q);
    if (sourceUrl) evidence.push({ fields: [field], sourceUrl, quote: q });
    return Boolean(sourceUrl);
  };
  const optional = (fact, q, field) => {
    if (fact === null || supported(q, field)) return fact;
    output.issues.push(`${field}: unsupported, set to unknown`);
    return null;
  };
  const core = (field, message) => {
    output.issues.push(`${field}: ${message}`);
    review.push({ field, reason: message });
  };
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
  const checkRule = (rule) => {
    requireFact(rule.frequency !== 'weekly' || rule.weekdays !== null, '/', 'weekly days missing');
    requireFact(
      rule.frequency === 'monthly' || (rule.monthDays === null && rule.weekOfMonth === null),
      '/',
      'monthly selector on non-monthly rule',
    );
    requireFact(
      rule.frequency !== 'daily' || rule.weekdays === null,
      '/',
      'daily rule cannot select weekdays',
    );
    if (rule.frequency === 'monthly')
      requireFact(
        (rule.monthDays !== null && rule.weekOfMonth === null && rule.weekdays === null) ||
          (rule.monthDays === null && rule.weekOfMonth !== null && rule.weekdays !== null),
        '/',
        'choose month days or ordinal weekdays',
      );
  };
  const withOffset = (slot) => ({
    startTime: slot.startTime,
    endTime: slot.endTime,
    endDayOffset: overnight(slot),
  });
  // Keep each schedule entry only if its quote is found and its facts are coherent.
  function keep(list, path, convert) {
    const kept = [];
    list.forEach((entry, i) => {
      const field = `${path}/${i}`;
      if (!supported(entry.quote, field)) return core(field, 'unsupported schedule entry');
      try {
        kept.push(convert(entry));
      } catch (error) {
        core(field, error.message.replace(/^Invalid extraction at \S+: /, ''));
      }
    });
    return kept;
  }

  if (event.title !== null && !supported(event.titleQuote, '/title'))
    core('/title', 'unsupported title');
  let venue = null;
  if (event.venue && supported(event.venue.quote, '/venue')) {
    const address = event.venue.address;
    venue = {
      name: event.venue.name,
      address: address && findQuote(address) ? address : null,
      mode: event.venue.online ? 'online' : null,
    };
  } else if (event.venue) output.issues.push('/venue: unsupported, set to unknown');
  const price = optional(event.price, event.price?.quote, '/price');

  const s = event.schedule;
  let run = null;
  if (s.run) {
    if (!supported(s.run.quote, '/schedule/run')) core('/schedule/run', 'unsupported run dates');
    else
      try {
        checkRange(s.run.from, s.run.through);
        run = { from: s.run.from, through: s.run.through };
      } catch (error) {
        core('/schedule/run', error.message.replace(/^Invalid extraction at \S+: /, ''));
      }
  }
  const dates = keep(s.dates, '/schedule/dates', (d) => {
    checkRange(d.start, d.end);
    const slot = withOffset(d);
    if (d.end) {
      const days =
        (Date.parse(resolveDate(d.end, year).value) -
          Date.parse(resolveDate(d.start, year).value)) /
        DAY;
      if (slot.endTime !== null) slot.endDayOffset = days;
      requireFact(
        days > 0 || slot.endTime === null || !slot.startTime || slot.endTime >= slot.startTime,
        '/',
        'reversed local times',
      );
    }
    return {
      start: d.start,
      end: d.end,
      ...slot,
      status: d.cancelled ? 'cancelled' : 'active',
    };
  });
  const recurrence = keep(s.recurrence, '/schedule/recurrence', (r) => {
    checkRange(r.from, r.through);
    checkRule(r);
    const { quote: _quote, ...rule } = r;
    return { ...rule, ...withOffset(r) };
  });
  const hours = keep(s.hours, '/schedule/hours', (h) => {
    checkRange(h.from, h.through);
    return {
      from: h.from,
      through: h.through,
      weekly: h.weekly.map((w) => ({ ...w, ...withOffset(w) })),
    };
  });
  const exceptions = keep(s.exceptions, '/schedule/exceptions', (e) => {
    checkRange(e.from, e.through);
    requireFact(
      !e.closed || e.intervals === null,
      '/',
      'closed interval cannot have opening times',
    );
    return {
      from: e.from,
      through: e.through,
      closed: e.closed,
      intervals: e.intervals?.map(withOffset) ?? null,
    };
  });

  const kind =
    run && (hours.length || exceptions.length)
      ? 'exhibition'
      : recurrence.length
        ? 'recurring'
        : dates.length > 1
          ? 'multiple'
          : dates.length
            ? 'single'
            : null;
  const allCancelled =
    dates.length > 0 &&
    !recurrence.length &&
    !hours.length &&
    dates.every((d) => d.status === 'cancelled');
  const links = (u, field) => {
    if (u === null || published(u)) return u;
    output.issues.push(`${field}: URL not in supplied source material`);
    return null;
  };
  const imageUrls = [...new Set(event.imageUrls)].filter((u) => links(u, '/imageUrls'));

  output.events.push({
    sourceUrl: context.pageUrl,
    title: event.title,
    description: null,
    category: null,
    status: allCancelled ? 'cancelled' : null,
    venue,
    price: price && {
      amount: price.amount,
      currency: price.amount === null ? null : 'CAD',
      text: price.text,
    },
    organizerUrl: links(event.organizerUrl, '/organizerUrl'),
    ticketUrl: links(event.ticketUrl, '/ticketUrl'),
    images: imageUrls.map((u) => ({ url: u, kind: 'unknown', caption: null })),
    schedule: {
      kind,
      timeZone: null,
      run,
      dates,
      recurrence,
      hours,
      exceptions,
    },
    evidence,
    reviewReasons: review,
  });
  return output;
}

/** One prepared page yields at most one main event. */
export const parseMainEventExtraction = parseEventExtraction;
