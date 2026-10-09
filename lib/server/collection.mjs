// Runs one public-source collection job: fetch and parse, save, and record the run.
import { sources as publicSources, collectSourcePages } from '../connectors.mjs';
import { ROTARY_SOURCE_ID, collectRotary } from './rotary.mjs';

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

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (day) =>
  ISO_DAY.test(day) && new Date(day + 'T12:00:00Z').toISOString().slice(0, 10) === day;

/**
 * Why a parsed listing can't be saved, or null if it can. Catches parser drift that produces
 * half-filled records (missing title or link, impossible dates) instead of failing outright.
 */
export function invalidReason(item) {
  if (!item || typeof item !== 'object') return 'not a listing';
  if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 300)
    return 'title';
  try {
    if (!['http:', 'https:'].includes(new URL(item.url).protocol)) return 'url';
  } catch {
    return 'url';
  }
  if (item.start !== undefined && !validDay(item.start)) return 'start date';
  if (item.end !== undefined && !validDay(item.end)) return 'end date';
  if (item.start && item.end && item.end < item.start) return 'end before start';
  return null;
}

/** The collector for a source: Rotary reads posters, the rest are paged HTML sources. */
export const defaultCollect = (source, checkedAt, options) =>
  source.id === ROTARY_SOURCE_ID
    ? collectRotary(source, checkedAt)
    : collectSourcePages(source, checkedAt, options);

/** Collectors may return a plain list (tests, simple sources) or a paged result. */
function asPagedResult(result) {
  const paged = Array.isArray(result) ? { items: result, pagesRead: 1, failedPages: [] } : result;
  return { eventPagesRead: 0, eventPageFailures: 0, allowEmpty: false, ...paged };
}

/** A short, log-safe description; never includes page content. */
function describe(error) {
  const message = String(error?.message || 'Collection failed').replace(/\s+/g, ' ');
  return message.slice(0, 300);
}

/**
 * Collects `sourceId` once and returns the run's final status: ok, partial (a later page failed;
 * what was read is saved), warning (saved, but the count dropped sharply), or error.
 *
 * `job` comes from the queue: `{ id, data: { trigger }, retryCount, retryLimit }`. A transient
 * failure of the first page before the last attempt rethrows so the queue retries it; every other
 * outcome completes the job. On failure the source keeps its previous listings.
 */
export async function runCollection(sourceId, job, { pool, repository, collect = defaultCollect }) {
  const source = localSources.find((candidate) => candidate.id === sourceId);
  if (!source) throw Error('Unknown source');
  const attempt = (job.retryCount ?? 0) + 1;
  const run = await startRun(pool, sourceId, job, attempt);
  const attemptedAt = new Date().toISOString();
  try {
    const knownDescriptions = (await repository.knownDescriptions?.(sourceId)) ?? new Map();
    const {
      items: parsed,
      pagesRead,
      failedPages,
      eventPagesRead,
      eventPageFailures,
      allowEmpty,
    } = asPagedResult(await collect(source, attemptedAt, { knownDescriptions }));
    const items = parsed.filter((item) => !invalidReason(item));
    const rejected = parsed.length - items.length;
    // A source that can legitimately have no events (Rotary between events) may return none.
    if (!items.length && !(allowEmpty && !parsed.length))
      throw Error(
        parsed.length
          ? `All ${parsed.length} listings failed validation; the page layout may have changed`
          : 'No listings found; the calendar may have changed',
      );
    const partial = failedPages.length > 0;
    const { counts, warning } = await repository.applySourceCollection(sourceId, items, {
      checkedAt: attemptedAt,
      // A partial read is not a complete schedule, so it never cancels anything.
      cancelMissing: CANCEL_MISSING.has(sourceId) && !partial,
      complete: !partial,
    });
    const notes = [
      partial ? `${failedPages.length} page(s) unavailable: ${failedPages[0].error}` : null,
      warning,
      rejected ? `${rejected} listing(s) rejected by validation` : null,
      eventPageFailures ? `${eventPageFailures} event page(s) unavailable; retried next run` : null,
    ].filter(Boolean);
    const status = partial ? 'partial' : warning ? 'warning' : 'ok';
    const runCounts = { ...counts, rejected, pages: pagesRead, eventPages: eventPagesRead };
    await finishRun(pool, run, status, runCounts, notes.join('; ') || null);
    return { status, counts: runCounts };
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
