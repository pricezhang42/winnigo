// Read a local reference manifest and compare a live extraction with a parser snapshot.
import { open, readFile } from 'node:fs/promises';
import { resolveExtractionDate } from '../lib/contracts/event-extraction.mjs';
import { createConfiguredEventExtractionService } from '../lib/server/openai-event-extraction.mjs';

const fields = new Set([
  'title',
  'venue',
  'sourceUrl',
  'date',
  'endDate',
  'startTime',
  'endTime',
  'dates',
  'showtimes',
  'recurring',
  'closedDates',
  'openWeekdays',
  'imageUrl',
  'review',
]);
const ordered = (values) => [...new Set(values)].sort();
const normalized = (value) =>
  typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim() : value;

function modelFacts(event, context) {
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
  const timing = first ?? recurrence ?? schedule.hours?.[0]?.weekly[0];
  const offsetEnd =
    last?.endDayOffset > 0
      ? new Date(Date.parse(last.day) + last.endDayOffset * 86400000).toISOString().slice(0, 10)
      : null;
  return {
    title: event.title,
    venue: event.venue?.name ?? (event.venue?.mode === 'online' ? 'Online' : null),
    sourceUrl: event.sourceUrl,
    date: date(schedule.run?.from ?? null) || first?.day || date(recurrence?.from ?? null),
    endDate:
      date(schedule.run?.through ?? recurrence?.through ?? last?.end ?? null) ||
      offsetEnd ||
      (last?.day !== first?.day ? last.day : null),
    startTime: timing?.startTime ?? null,
    endTime: timing?.endTime ?? null,
    dates: ordered(slots.map((row) => row.day)),
    showtimes: slots.filter((row) => row.startTime).map((row) => row.day + ' ' + row.startTime),
    recurring: Boolean(schedule.recurrence?.length) || schedule.kind === 'recurring',
    closedDates: ordered(
      (schedule.exceptions || []).filter((row) => row.closed).map((row) => date(row.from)),
    ),
    openWeekdays: ordered(
      (schedule.hours || []).flatMap((period) => period.weekly.flatMap((row) => row.weekdays)),
    ),
    imageUrls: (event.images || []).map((image) => image.url),
    review: event.reviewReasons.length > 0,
  };
}

function score(expected, actual) {
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
    return normalized(value) === normalized(actual[field]);
  };
  return {
    missing: expected !== null && actual === null,
    extra: expected === null && actual !== null,
    fields: Object.fromEntries(
      Object.entries(expected || {}).map((entry) => [entry[0], matches(entry)]),
    ),
  };
}

function validateManifest(cases) {
  if (!Array.isArray(cases) || !cases.length) throw Error('A nonempty pilot manifest is required');
  const ids = new Set();
  for (const item of cases) {
    if (
      typeof item.id !== 'string' ||
      !item.id ||
      ids.has(item.id) ||
      !item.context ||
      (item.expected !== null &&
        (!item.expected ||
          !Object.keys(item.expected).length ||
          Object.keys(item.expected).some((field) => !fields.has(field))))
    )
      throw Error('Pilot cases need unique IDs, prepared contexts and supported reference fields');
    ids.add(item.id);
  }
}

function totals(scores) {
  const fields = {};
  let missing = 0;
  let extra = 0;
  for (const score of scores) {
    missing += Number(score.missing);
    extra += Number(score.extra);
    for (const [field, correct] of Object.entries(score.fields)) {
      const count = (fields[field] ??= { correct: 0, total: 0 });
      count.correct += Number(correct);
      count.total++;
    }
  }
  return { cases: scores.length, missing, extra, fields };
}

const [manifestFile, reportFile] = process.argv.slice(2);
if (!manifestFile || !reportFile || manifestFile === reportFile)
  throw Error('Usage: check-event-extraction-pilot.mjs MANIFEST.json REPORT.json');
const cases = JSON.parse(await readFile(manifestFile, 'utf8'));
validateManifest(cases);
const service = createConfiguredEventExtractionService();
if (!service) throw Error('Configure an opt-in extraction provider before running the pilot');
const results = [];

async function evaluate({ id, context, expected, baseline }) {
  let facts = null;
  let metrics;
  let errorCode;
  let httpStatus;
  try {
    const { result, ...usage } = await service.extract(context);
    metrics = usage;
    facts = modelFacts(result.events[0], context);
  } catch (error) {
    metrics = error.metrics;
    errorCode = error.code || 'pilot_error';
    httpStatus = error.status;
  }
  return {
    id,
    source: context.source,
    url: context.pageUrl,
    expected,
    facts,
    metrics,
    errorCode,
    httpStatus,
    modelScore: score(expected, facts),
    ...(baseline === undefined ? {} : { baseline, parserScore: score(expected, baseline) }),
  };
}

const reportHandle = await open(reportFile, 'wx', 0o600);
try {
  for (let i = 0; i < cases.length; i += 3) {
    const batch = await Promise.all(cases.slice(i, i + 3).map(evaluate));
    for (const row of batch) {
      results.push(row);
      const outcome = row.httpStatus ? row.errorCode + ' (' + row.httpStatus + ')' : row.errorCode;
      console.log(`${results.length}/${cases.length} ${row.id} ${outcome || 'ok'}`);
    }
    if (batch.some((row) => [401, 403, 429].includes(row.httpStatus))) break;
  }
  const report = {
    model: service.model,
    plannedCases: cases.length,
    modelScore: totals(results.map((row) => row.modelScore)),
    parserScore: totals(results.flatMap((row) => (row.parserScore ? [row.parserScore] : []))),
    budget: service.budget(),
    results,
  };
  await reportHandle.writeFile(JSON.stringify(report, null, 2) + '\n');
} finally {
  await reportHandle.close();
}
