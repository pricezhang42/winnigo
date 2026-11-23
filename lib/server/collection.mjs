// Runs one collection job (P5 queue). Event sources from config/sources.mjs are crawled, read by
// AI extraction and published for review afterwards (docs/30); The Forks' places page is parsed
// into place listings.
import { EVENT_SOURCES } from '../../config/sources.mjs';
import { collectPlaces, placeSources } from '../connectors.mjs';
import { crawlSource, extractPages } from './event-sources.mjs';
import { finishRun, publishCollection, storedExtractions } from './event-store.mjs';
import { createConfiguredEventExtractionService } from './openai-event-extraction.mjs';

// A run may take this long before its job lease expires (pg-boss `expireInSeconds`).
const EVENT_JOB_SECONDS = 3600;
const CRAWL_MS = 1_800_000;
const EXTRACT_MS = 1_500_000;

/** The URL shown for an event source: its first start page, or its site when that is templated. */
const homeUrl = (definition) =>
  definition.fetch.startUrls.find((url) => !url.includes('{')) || definition.fetch.allowedOrigin;

/**
 * Sources the worker can collect: every event source that is not blocked, plus places. Paused
 * sources stay listed (their stored events remain) but are left out of refresh-all.
 */
export const collectableSources = [
  ...EVENT_SOURCES.filter((source) => source.status !== 'blocked').map((source) => ({
    id: source.id,
    name: source.name,
    url: homeUrl(source),
    kind: 'events',
    status: source.status,
    timeoutSeconds: EVENT_JOB_SECONDS,
  })),
  ...placeSources.map((source) => ({ ...source, kind: 'places', status: 'active' })),
];

/**
 * Network trouble is worth retrying; anything else (an HTTP 4xx, an unexpected page size, a
 * missing configuration) usually needs a person, so it is not retried.
 */
export function isTransient(error) {
  if (['TimeoutError', 'AbortError'].includes(error?.name)) return true;
  if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(error?.cause?.code))
    return true;
  const message = error?.message || '';
  return (
    /^Source returned HTTP (5\d\d|429)$/.test(message) ||
    /fetch failed|ECONNRESET|ETIMEDOUT|timed out|aborted/i.test(message)
  );
}

/** A short, log-safe description; never includes page content. */
function describe(error) {
  return String(error?.message || 'Collection failed')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

/** The configured extractor, with this source's token limits raising (never lowering) the defaults. */
export function sourceExtractor(definition, env = process.env) {
  const settings = { ...env };
  for (const [key, name] of [
    ['maxInputTokens', 'WINNIGO_EXTRACTION_MAX_INPUT_TOKENS'],
    ['maxOutputTokens', 'WINNIGO_EXTRACTION_MAX_OUTPUT_TOKENS'],
  ]) {
    const wanted = definition.extraction?.[key];
    if (wanted && !(Number(settings[name]) >= wanted)) settings[name] = String(wanted);
  }
  return createConfiguredEventExtractionService(settings);
}

/**
 * Crawls, extracts and publishes one event source. Unchanged pages reuse their stored model
 * output. A crawl that reads nothing throws its first failure, so the queue can retry it.
 */
export async function collectEventSource(
  pool,
  definition,
  {
    runId = null,
    checkedAt = new Date().toISOString(),
    fetchImpl,
    pauseMs,
    extractor,
    maxRunMs = CRAWL_MS,
  } = {},
) {
  extractor ??= sourceExtractor(definition);
  if (!extractor) throw Error('Event extraction is not configured (WINNIGO_EXTRACTION_PROVIDER)');
  const crawl = await crawlSource(definition, {
    checkedAt,
    maxRunMs,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(pauseMs !== undefined ? { pauseMs } : {}),
  });
  if (!crawl.pages.length && crawl.failedPages.length) throw Error(crawl.failedPages[0].error);
  const result = await extractPages(definition, crawl, {
    extractor,
    checkedAt,
    maxMs: EXTRACT_MS,
    reuse: await storedExtractions(pool, definition.id),
  });
  const published = await publishCollection(pool, definition, crawl, result, { runId });
  const failed = result.counts.failed + crawl.failedPages.length;
  return {
    crawl,
    result,
    published,
    status: failed ? 'partial' : 'ok',
    counts: { ...result.counts, ...published, listPages: crawl.listPagesRead },
    note: failed ? `${failed} page(s) unavailable or unread; their events are kept` : null,
  };
}

/** Saves one places collection through the repository (place listings keep owner edits). */
async function collectPlaceSource(repository, source, checkedAt, fetchPage) {
  const { items, pagesRead } = await collectPlaces(source, checkedAt, {
    ...(fetchPage ? { fetchPage } : {}),
  });
  if (!items.length) throw Error('No places found; the page may have changed');
  const { counts, warning } = await repository.applySourceCollection(source.id, items, {
    checkedAt,
  });
  return {
    status: warning ? 'warning' : 'ok',
    counts: { ...counts, pages: pagesRead },
    note: warning,
  };
}

/**
 * Collects `sourceId` once and returns the run's final status: ok, partial (some pages failed;
 * what was read is published), warning, or error.
 *
 * `job` comes from the queue: `{ id, data: { trigger }, retryCount, retryLimit }`. A transient
 * failure before anything was read rethrows on all but the last attempt so the queue retries it;
 * every other outcome completes the job. On failure the source keeps what it had.
 */
export async function runCollection(
  sourceId,
  job,
  {
    pool,
    repository,
    now = () => new Date().toISOString(),
    fetchImpl,
    fetchPage,
    pauseMs,
    extractor,
  },
) {
  const source = collectableSources.find((candidate) => candidate.id === sourceId);
  if (!source) throw Error('Unknown source');
  const attempt = (job.retryCount ?? 0) + 1;
  const run = await startJobRun(pool, sourceId, job, attempt);
  const attemptedAt = now();
  try {
    const outcome =
      source.kind === 'places'
        ? await collectPlaceSource(repository, source, attemptedAt, fetchPage)
        : await collectEventSource(
            pool,
            EVENT_SOURCES.find((definition) => definition.id === sourceId),
            { runId: run, checkedAt: attemptedAt, fetchImpl, pauseMs, extractor },
          );
    await finishRun(pool, run, outcome.status, outcome.counts, outcome.note);
    return { status: outcome.status, counts: outcome.counts };
  } catch (error) {
    const retry = isTransient(error) && attempt <= (job.retryLimit ?? 0);
    await recordSourceFailure(pool, sourceId, describe(error), attemptedAt);
    await pool.query(
      `UPDATE collection_runs SET status=$2, error=$3,
         finished_at = CASE WHEN $2 = 'retrying' THEN NULL ELSE now() END WHERE id=$1`,
      [run, retry ? 'retrying' : 'error', describe(error)],
    );
    if (retry) throw error;
    return { status: 'error', error: describe(error) };
  }
}

/** Creates a pending source row if this source has never been seen (runs reference it). */
export async function ensureSource(pool, sourceId) {
  await pool.query('INSERT INTO sources(id, report) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
    sourceId,
    { id: sourceId, status: 'pending', count: 0, checkedAt: '' },
  ]);
}

/** Marks a source as failing while keeping its listings or events and last successful check. */
async function recordSourceFailure(pool, sourceId, error, attemptedAt) {
  await pool.query(
    `INSERT INTO sources VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET report = sources.report || excluded.report`,
    [sourceId, { id: sourceId, attemptedAt, status: 'error', error }],
  );
}

/** The run row for a job: created when it was queued, or now for a scheduled one. */
async function startJobRun(pool, sourceId, job, attempt) {
  await ensureSource(pool, sourceId);
  const result = await pool.query(
    `INSERT INTO collection_runs(source, status, trigger, job_id, attempts, started_at)
     VALUES ($1, 'running', $2, $3, $4, now())
     ON CONFLICT (job_id) DO UPDATE SET status = 'running', attempts = excluded.attempts,
       started_at = coalesce(collection_runs.started_at, now()), finished_at = NULL, error = NULL
     RETURNING id`,
    [sourceId, job.data?.trigger || 'schedule', job.id, attempt],
  );
  return result.rows[0].id;
}

/** Most recent runs, newest first, for the admin run history. */
export async function recentRuns(pool, limit = 50) {
  const result = await pool.query(
    `SELECT id, source, status, trigger, attempts, counts, error, created_at AS "createdAt",
       started_at AS "startedAt", finished_at AS "finishedAt"
     FROM collection_runs ORDER BY created_at DESC, id DESC LIMIT $1`,
    [Math.min(200, Math.max(1, limit))],
  );
  return result.rows;
}
