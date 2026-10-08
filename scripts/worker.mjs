// Background worker process (npm run worker). With PostgreSQL it processes collection jobs and,
// when WINNIGO_SCHEDULES=enabled, registers the daily source schedules. It writes a heartbeat file
// for the container health check. --once checks storage (and the job queue) and exits.
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadLocalEnv } from './load-env.mjs';
import { readConfig } from '../lib/server/config.mjs';
import { getRepository } from '../lib/server/adapters.mjs';
import { database } from '../lib/server/postgres.mjs';
import { runCollection } from '../lib/server/collection.mjs';
import {
  COLLECTION_QUEUE,
  createBoss,
  schedulesEnabled,
  syncSchedules,
} from '../lib/server/job-queue.mjs';

loadLocalEnv();
const config = readConfig();
const once = process.argv.includes('--once');
const repository = getRepository();
await repository.health();

let boss;
if (config.repository === 'postgres') {
  boss = createBoss({ worker: !once });
  try {
    await boss.start();
  } catch {
    console.error('Job queue unavailable. Run npm run db:migrate, then start the worker again.');
    process.exit(1);
  }
  if (!(await boss.getQueue(COLLECTION_QUEUE))) {
    console.error('Collection queue missing. Run npm run db:migrate.');
    process.exit(1);
  }
}

if (once) {
  await boss?.stop({ graceful: false });
  console.log('Winnigo worker check passed.');
  process.exit(0);
}

if (boss) {
  const pool = database();
  // One job at a time keeps load on source websites low; jobs for different sources run in turn.
  await boss.work(COLLECTION_QUEUE, { includeMetadata: true }, async ([job]) => {
    const result = await runCollection(job.data.sourceId, job, { pool, repository });
    console.log(`Collected ${job.data.sourceId}: ${result.status}`);
    return result;
  });
  await syncSchedules(boss);
  console.log(
    schedulesEnabled()
      ? 'Winnigo worker ready. Source schedules are enabled (America/Winnipeg).'
      : 'Winnigo worker ready. Schedules are off (set WINNIGO_SCHEDULES=enabled); manual refreshes run.',
  );
} else console.log('Winnigo worker ready. Collection jobs need the PostgreSQL repository.');

const file = join(config.dataDir, 'worker-heartbeat');
await mkdir(config.dataDir, { recursive: true });
const heartbeat = () => writeFile(file, String(Date.now()), { mode: 0o600 });
await heartbeat();
const timer = setInterval(
  () =>
    heartbeat().catch(() => {
      console.error('Worker heartbeat failed');
      process.exit(1);
    }),
  15000,
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    clearInterval(timer);
    // Let an in-flight collection finish (up to 30 s); an unfinished job's lease will expire and
    // another worker run picks it up.
    await boss?.stop({ graceful: true, timeout: 30000 }).catch(() => {});
    process.exit(0);
  });
