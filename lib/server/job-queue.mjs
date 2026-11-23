// Durable collection jobs on pg-boss (PostgreSQL-backed; no extra service).
import { PgBoss } from 'pg-boss';
import { collectableSources, ensureSource } from './collection.mjs';

export const COLLECTION_QUEUE = 'collect-source';
export const TIMEZONE = 'America/Winnipeg';

// At most one queued and one running job per source (singletonKey = source ID). The policy is
// fixed when the queue is created; the other settings are updated on every migration.
const QUEUE_POLICY = 'stately';
// Network failures retry with backoff; a lease expires after ten minutes if a worker dies mid-run.
const QUEUE_SETTINGS = {
  retryLimit: 2,
  retryDelay: 120,
  retryBackoff: true,
  expireInSeconds: 600,
  heartbeatSeconds: 60,
  retentionSeconds: 7 * 86400,
  deleteAfterSeconds: 30 * 86400,
};

export function jobsSchema(env = process.env) {
  const schema = env.WINNIGO_JOBS_SCHEMA || 'winnigo_jobs';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw Error('Invalid WINNIGO_JOBS_SCHEMA');
  return schema;
}

/** Schedules are registered only when WINNIGO_SCHEDULES=enabled, so local runs never fetch live sites unasked. */
export const schedulesEnabled = (env = process.env) => env.WINNIGO_SCHEDULES === 'enabled';

/**
 * A pg-boss instance. Workers supervise leases and run the cron clock; web processes only send.
 * Schema changes happen in `npm run db:migrate`, never at start-up.
 */
export function createBoss({
  connectionString = process.env.DATABASE_URL,
  schema = jobsSchema(),
  worker = false,
  migrate = false,
  ...options
} = {}) {
  const boss = new PgBoss({
    ...options,
    connectionString,
    schema,
    migrate,
    createSchema: migrate,
    supervise: worker,
    schedule: worker,
    max: worker ? 4 : 2,
    application_name: worker ? 'winnigo-worker' : 'winnigo-web',
  });
  // pg-boss reports background errors as events; without a listener they would crash the process.
  boss.on('error', (error) => console.error('Job queue error:', error.message));
  return boss;
}

export async function ensureCollectionQueue(boss) {
  if (await boss.getQueue(COLLECTION_QUEUE))
    await boss.updateQueue(COLLECTION_QUEUE, QUEUE_SETTINGS);
  else await boss.createQueue(COLLECTION_QUEUE, { policy: QUEUE_POLICY, ...QUEUE_SETTINGS });
}

/** Sources that can be queued: active ones (paused sources keep their events but are not read). */
const queueable = () => collectableSources.filter((source) => source.status === 'active');

/**
 * Sources collected on a schedule: active ones whose `schedule` is a cron expression in
 * America/Winnipeg (config/sources.mjs for events, lib/connectors.mjs for places). Facebook is
 * absent: its existing collector keeps running elsewhere until the P6 cutover, so there is only
 * ever one active Facebook schedule.
 */
export const scheduledSources = () =>
  queueable().filter((source) => source.schedule && source.schedule !== 'manual');

/**
 * Registers one schedule per scheduled source when WINNIGO_SCHEDULES=enabled, and removes every
 * other schedule on the queue: all of them when disabled, and any left by a source that is now
 * manual, paused, blocked or gone.
 */
export async function syncSchedules(boss, env = process.env) {
  const wanted = schedulesEnabled(env) ? scheduledSources() : [];
  for (const source of wanted)
    await boss.schedule(
      COLLECTION_QUEUE,
      source.schedule,
      { sourceId: source.id, trigger: 'schedule' },
      {
        tz: TIMEZONE,
        key: source.id,
        singletonKey: source.id,
        missed: 'once',
        // Event runs crawl and extract for longer than the queue's default lease.
        ...(source.timeoutSeconds ? { expireInSeconds: source.timeoutSeconds } : {}),
      },
    );
  const keys = new Set(wanted.map((source) => source.id));
  for (const schedule of await boss.getSchedules(COLLECTION_QUEUE))
    if (!keys.has(schedule.key)) await boss.unschedule(COLLECTION_QUEUE, schedule.key);
}

/**
 * Queues collection for the given sources and records a 'queued' run for each new job.
 * A source that already has a queued job is reported as `alreadyQueued` instead of duplicated.
 */
export async function enqueueCollection(boss, pool, sourceIds, trigger = 'manual') {
  const known = new Map(queueable().map((source) => [source.id, source]));
  const results = [];
  for (const sourceId of sourceIds) {
    if (!known.has(sourceId)) throw Error('Unknown source');
    const jobId = await boss.send(
      COLLECTION_QUEUE,
      { sourceId, trigger },
      {
        singletonKey: sourceId,
        ...(known.get(sourceId).timeoutSeconds
          ? { expireInSeconds: known.get(sourceId).timeoutSeconds }
          : {}),
      },
    );
    if (!jobId) {
      results.push({ sourceId, alreadyQueued: true });
      continue;
    }
    await ensureSource(pool, sourceId);
    const run = await pool.query(
      `INSERT INTO collection_runs(source, status, trigger, job_id) VALUES ($1, 'queued', $2, $3)
       ON CONFLICT (job_id) DO NOTHING RETURNING id`,
      [sourceId, trigger, jobId],
    );
    results.push({ sourceId, jobId, runId: run.rows[0]?.id ?? null });
  }
  return results;
}

let webBoss;
/** Shared sending-only instance for the web process. */
export async function webQueue() {
  webBoss ??= (async () => {
    const boss = createBoss();
    await boss.start();
    return boss;
  })().catch((error) => {
    webBoss = undefined;
    throw error;
  });
  return webBoss;
}

/**
 * Admin refresh: queues one source, or every active source with a schedule when `sourceId` is
 * omitted (sources collected only on request are refreshed one at a time). Returns per-source
 * results without waiting for collection to finish.
 */
export async function queueRefresh(sourceId, pool) {
  const ids = sourceId === undefined ? scheduledSources().map((source) => source.id) : [sourceId];
  return enqueueCollection(await webQueue(), pool, ids, 'manual');
}
