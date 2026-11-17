// Read a local reference manifest and compare a live extraction with a parser snapshot.
import { open, readFile } from 'node:fs/promises';
import { parseEventExtraction } from '../lib/contracts/event-extraction.mjs';
import { createConfiguredEventExtractionService } from '../lib/server/openai-event-extraction.mjs';

import { modelFacts, score } from './lib/extraction-pilot-scoring.mjs';

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
  'price',
  'availability',
]);

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

const [manifestFile, reportFile, admissionFile] = process.argv.slice(2);
if (!manifestFile || !reportFile || manifestFile === reportFile)
  throw Error(
    'Usage: check-event-extraction-pilot.mjs MANIFEST.json REPORT.json [ADMISSION_LABELS.json]',
  );
const cases = JSON.parse(await readFile(manifestFile, 'utf8'));
if (admissionFile) {
  const labels = JSON.parse(await readFile(admissionFile, 'utf8'));
  for (const [id, facts] of Object.entries(labels)) {
    const item = cases.find((c) => c.id === id && c.expected);
    if (!item || Object.keys(facts).some((key) => !['price', 'availability'].includes(key)))
      throw Error('Admission labels must match event cases and contain only price/availability');
    item.expected = { ...item.expected, ...facts };
  }
}
validateManifest(cases);
const service = createConfiguredEventExtractionService({
  ...process.env,
  WINNIGO_EXTRACTION_TIMEOUT_MS: process.env.WINNIGO_EXTRACTION_TIMEOUT_MS || '60000',
});
if (!service) throw Error('Configure an opt-in extraction provider before running the pilot');
const results = [];

async function evaluate({ id, context, expected, baseline }) {
  let facts = null;
  let metrics;
  let errorCode;
  let issues = [];
  let reviewReasons = [];
  let raw;
  let httpStatus;
  try {
    const { result, ...usage } = await service.extract(context);
    metrics = usage;
    raw = result;
    const parsed = parseEventExtraction(result, context);
    facts = modelFacts(parsed.events[0], context);
    issues = parsed.issues;
    reviewReasons = parsed.events[0]?.reviewReasons ?? [];
  } catch (error) {
    metrics = error.metrics;
    errorCode = error.code || 'pilot_error';
    httpStatus = error.status;
  }
  // The archived parser reference did not measure admission fields. Do not
  // count an unmeasured field as an incorrect prediction or an assumed unknown.
  const parserExpected =
    expected &&
    Object.fromEntries(
      Object.entries(expected).filter(
        ([key]) => !['price', 'availability'].includes(key) || Object.hasOwn(baseline || {}, key),
      ),
    );
  return {
    id,
    source: context.source,
    url: context.pageUrl,
    expected,
    facts,
    metrics,
    errorCode,
    httpStatus,
    issues,
    reviewReasons,
    // The validated model output, for diagnosing misses.
    raw,
    modelScore: score(expected, facts),
    ...(baseline === undefined ? {} : { baseline, parserScore: score(parserExpected, baseline) }),
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
