// Durable collection jobs on pg-boss (PostgreSQL-backed; no extra service).
import { PgBoss } from 'pg-boss';
import { ensureSource, localSources } from './collection.mjs';

export const COLLECTION_QUEUE = 'collect-source';
export const TIMEZONE = 'America/Winnipeg';

/**
 * Collection schedules (cron in America/Winnipeg). Public sources are checked daily; free swim
 * twice a day because closures change. Facebook is deliberately absent: its existing collector
 * keeps running elsewhere until P6 cutover, so there is only ever one active Facebook schedule.
 */
export const SCHEDULES = {
  'winnipeg-free-swim': '0 6,15 * * *',
  forks: '0 6 * * *',
  park: '0 6 * * *',
  attractions: '0 6 * * *',
  manitoba: '0 6 * * *',
};

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

/** Registers (or, when disabled, removes) one schedule per source. */
export async function syncSchedules(boss, env = process.env) {
  for (const sourceId of Object.keys(SCHEDULES)) {
    if (schedulesEnabled(env))
      await boss.schedule(
        COLLECTION_QUEUE,
        SCHEDULES[sourceId],
        { sourceId, trigger: 'schedule' },
        { tz: TIMEZONE, key: sourceId, singletonKey: sourceId, missed: 'once' },
      );
    else await boss.unschedule(COLLECTION_QUEUE, sourceId);
  }
}

/**
 * Queues collection for the given sources and records a 'queued' run for each new job.
 * A source that already has a queued job is reported as `alreadyQueued` instead of duplicated.
 */
export async function enqueueCollection(boss, pool, sourceIds, trigger = 'manual') {
  const known = new Set(localSources.map((source) => source.id));
  const results = [];
  for (const sourceId of sourceIds) {
    if (!known.has(sourceId)) throw Error('Unknown source');
    const jobId = await boss.send(
      COLLECTION_QUEUE,
      { sourceId, trigger },
      { singletonKey: sourceId },
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
 * Admin refresh: queues one source, or every public source when `sourceId` is omitted.
 * Returns per-source results without waiting for collection to finish.
 */
export async function queueRefresh(sourceId, pool) {
  const ids = sourceId === undefined ? localSources.map((source) => source.id) : [sourceId];
  return enqueueCollection(await webQueue(), pool, ids, 'manual');
}
