// Runs one public-source collection job: fetch and parse, save, and record the run.
import { sources as publicSources, collectSource } from '../connectors.mjs';

/** Sources the worker collects over HTTP. Facebook and Trails Manitoba are imported separately. */
export const localSources = publicSources;

// Only free swim publishes a complete schedule, so a session that disappears was cancelled.
// For every other source, absence may just mean the calendar page moved on; keep the listing.
const CANCEL_MISSING = new Set(['winnipeg-free-swim']);

/**
 * Network trouble is worth retrying; anything else (an HTTP 4xx, an unexpected page size, a parser
 * that finds nothing) usually means the site changed and needs a person, so it is not retried.
 */
export function isTransient(error) {
  if (['TimeoutError', 'AbortError'].includes(error?.name)) return true;
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) return true;
  if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(error?.cause?.code))
    return true;
  return /^Source returned HTTP (5\d\d|429)$/.test(error?.message || '');
}

/** A short, log-safe description; never includes page content. */
function describe(error) {
  const message = String(error?.message || 'Collection failed').replace(/\s+/g, ' ');
  return message.slice(0, 300);
}

/**
 * Collects `sourceId` once and returns the run's final status.
 *
 * `job` comes from the queue: `{ id, data: { trigger }, retryCount, retryLimit }`. A transient
 * failure before the last attempt rethrows so the queue retries it; every other outcome
 * completes the job. On failure the source keeps its previous listings.
 */
export async function runCollection(sourceId, job, { pool, repository, collect = collectSource }) {
  const source = localSources.find((candidate) => candidate.id === sourceId);
  if (!source) throw Error('Unknown source');
  const attempt = (job.retryCount ?? 0) + 1;
  const run = await startRun(pool, sourceId, job, attempt);
  const attemptedAt = new Date().toISOString();
  try {
    const items = await collect(source, attemptedAt);
    if (!items.length) throw Error('No listings found; the calendar may have changed');
    const counts = await repository.applySourceCollection(sourceId, items, {
      checkedAt: attemptedAt,
      cancelMissing: CANCEL_MISSING.has(sourceId),
    });
    await finishRun(pool, run, 'ok', counts, null);
    return { status: 'ok', counts };
  } catch (error) {
    const retry = isTransient(error) && attempt <= (job.retryLimit ?? 0);
    await repository.recordSourceFailure(sourceId, describe(error), attemptedAt);
    await finishRun(pool, run, retry ? 'retrying' : 'error', {}, describe(error));
    if (retry) throw error;
    return { status: 'error', error: describe(error) };
  }
}

/** Creates a pending source row if this source has never been seeded (runs reference it). */
export async function ensureSource(pool, sourceId) {
  await pool.query('INSERT INTO sources(id, report) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
    sourceId,
    { id: sourceId, status: 'pending', count: 0, checkedAt: '' },
  ]);
}

async function startRun(pool, sourceId, job, attempt) {
  const trigger = job.data?.trigger || 'schedule';
  await ensureSource(pool, sourceId);
  const result = await pool.query(
    `INSERT INTO collection_runs(source, status, trigger, job_id, attempts, started_at)
     VALUES ($1, 'running', $2, $3, $4, now())
     ON CONFLICT (job_id) DO UPDATE SET status = 'running', attempts = excluded.attempts,
       started_at = coalesce(collection_runs.started_at, now()), finished_at = NULL, error = NULL
     RETURNING id`,
    [sourceId, trigger, job.id, attempt],
  );
  return result.rows[0].id;
}

async function finishRun(pool, runId, status, counts, error) {
  await pool.query(
    `UPDATE collection_runs SET status = $2, counts = $3, error = $4,
       finished_at = CASE WHEN $2 = 'retrying' THEN NULL ELSE now() END
     WHERE id = $1`,
    [runId, status, counts, error],
  );
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
