// P5 integration check (npm run check:p5): collection jobs against a temporary PostgreSQL schema
// and a temporary pg-boss schema. Sources are faked, so no live website is contacted.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { serviceConfig } from './check-services.mjs';
import { PostgresRepository } from '../lib/server/postgres-repository.mjs';
import { applyAction } from '../lib/server/actions.mjs';
import { ensureSource, runCollection } from '../lib/server/collection.mjs';
import {
  COLLECTION_QUEUE,
  SCHEDULES,
  TIMEZONE,
  createBoss,
  enqueueCollection,
  ensureCollectionQueue,
  syncSchedules,
} from '../lib/server/job-queue.mjs';

const config = serviceConfig();
const stamp = Date.now();
const schema = 'p5_test_' + stamp;
const jobsSchema = 'p5_jobs_' + stamp;
const admin = new Pool({ connectionString: config.connectionString });
const pool = new Pool({
  connectionString: config.connectionString,
  options: `-c search_path=${schema}`,
  max: 8,
});
const repo = new PostgresRepository(pool);
const owner = { userId: 'p5-owner', role: 'owner' };
const bossFor = (options = {}) =>
  createBoss({ connectionString: config.connectionString, schema: jobsSchema, ...options });

// Fake sources: `responses[sourceId]` is a list of items or an Error to throw.
const responses = {};
const collect = async (source, checkedAt) => {
  const response = responses[source.id];
  if (response instanceof Error) throw response;
  return response.map((item) => ({ ...item, checkedAt }));
};
const listing = (source, id, extra = {}) => ({
  id,
  source,
  title: 'P5 ' + id,
  url: 'https://example.test/' + id,
  type: 'Event',
  category: 'Family',
  venue: 'Synthetic Hall',
  neighbourhood: 'Downtown',
  start: '2099-06-01',
  schedule: 'event',
  description: 'Synthetic listing',
  sourceName: 'P5 fixture',
  price: 0,
  family: true,
  indoor: true,
  image: '',
  status: 'active',
  ...extra,
});
const deps = { pool, repository: repo, collect };
const runRow = async (jobId) =>
  (await pool.query('SELECT * FROM collection_runs WHERE job_id = $1', [jobId])).rows;
const report = async (id) =>
  (await pool.query('SELECT report FROM sources WHERE id = $1', [id])).rows[0]?.report;
const payload = async (id) =>
  (await pool.query('SELECT payload FROM listings WHERE id = $1', [id])).rows[0]?.payload;
const audits = async (action) =>
  (await pool.query('SELECT count(*)::int AS n FROM audit_records WHERE action = $1', [action]))
    .rows[0].n;

const checks = [];
let boss;
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  for (const file of ['0001_foundation.sql', '0002_discovery.sql', '0005_collection_runs.sql'])
    await pool.query(await readFile('migrations/postgres/' + file, 'utf8'));
  boss = bossFor({ migrate: true });
  await boss.start();
  await ensureCollectionQueue(boss);
  await ensureCollectionQueue(boss); // second call updates settings without error

  // 1. Manual refresh queues one job per source and never duplicates a queued one.
  const [first] = await enqueueCollection(boss, pool, ['forks'], 'manual');
  assert.ok(first.jobId && first.runId);
  assert.equal((await runRow(first.jobId))[0].status, 'queued');
  const [again] = await enqueueCollection(boss, pool, ['forks'], 'manual');
  assert.equal(again.alreadyQueued, true);
  await assert.rejects(enqueueCollection(boss, pool, ['facebook']), /Unknown source/);
  checks.push('Refresh queues jobs; duplicates and unknown sources refused');

  // 2. A successful run saves listings, counts them and records the run.
  responses.forks = [listing('forks', 'p5-a'), listing('forks', 'p5-b')];
  let [job] = await boss.fetch(COLLECTION_QUEUE, { includeMetadata: true });
  assert.equal(job.id, first.jobId);
  let result = await runCollection('forks', job, deps);
  await boss.complete(COLLECTION_QUEUE, job.id);
  assert.deepEqual(result.counts, { found: 2, added: 2, updated: 0, unchanged: 0, cancelled: 0 });
  let [row] = await runRow(job.id);
  assert.equal(row.status, 'ok');
  assert.equal(row.trigger, 'manual');
  assert.equal(row.attempts, 1);
  assert.ok(row.started_at && row.finished_at);
  assert.equal((await report('forks')).status, 'ok');
  assert.equal((await report('forks')).count, 2);
  checks.push('Successful run saves listings, source report and run record');

  // 3. Re-collecting identical content refreshes check times without counting changes,
  //    and owner corrections survive.
  await applyAction({ action: 'update', id: 'p5-a', title: 'Owner title' }, repo, owner);
  const firstCheck = (await payload('p5-a')).checkedAt;
  await sleep(5);
  const send = (sourceId, options = {}) =>
    boss.send(
      COLLECTION_QUEUE,
      { sourceId, trigger: 'schedule' },
      { singletonKey: sourceId, ...options },
    );
  let jobId = await send('forks');
  [job] = await boss.fetch(COLLECTION_QUEUE, { includeMetadata: true });
  result = await runCollection('forks', job, deps);
  await boss.complete(COLLECTION_QUEUE, jobId);
  assert.deepEqual(result.counts, { found: 2, added: 0, updated: 0, unchanged: 2, cancelled: 0 });
  assert.notEqual((await payload('p5-a')).checkedAt, firstCheck);
  assert.equal(await audits('collect'), 2);
  assert.equal((await repo.detail('p5-a', { admin: true, principal: owner })).title, 'Owner title');
  checks.push('Unchanged content is not counted or audited; owner corrections preserved');

  // 4. Changed content counts as an update; a source that drops a listing keeps it (not free swim).
  responses.forks = [listing('forks', 'p5-a', { description: 'Changed description' })];
  jobId = await send('forks');
  [job] = await boss.fetch(COLLECTION_QUEUE, { includeMetadata: true });
  result = await runCollection('forks', job, deps);
  await boss.complete(COLLECTION_QUEUE, jobId);
  assert.equal(result.counts.updated, 1);
  assert.equal(result.counts.cancelled, 0);
  assert.equal((await payload('p5-b')).status, 'active');
  assert.equal(await audits('collect'), 3);
  checks.push('Content changes counted; missing listings kept for ordinary sources');

  // 5. Layout changes and empty pages fail without retrying and keep earlier listings.
  const lastGood = (await report('forks')).checkedAt;
  for (const failure of [Error('Forks layout changed'), []]) {
    responses.forks = failure;
    jobId = await send('forks');
    [job] = await boss.fetch(COLLECTION_QUEUE, { includeMetadata: true });
    result = await runCollection('forks', job, deps);
    await boss.complete(COLLECTION_QUEUE, jobId);
    assert.equal(result.status, 'error');
    assert.equal((await runRow(jobId))[0].status, 'error');
    assert.equal((await report('forks')).status, 'error');
    assert.equal((await report('forks')).checkedAt, lastGood);
    assert.equal((await payload('p5-b')).status, 'active');
  }
  assert.match((await runRow(jobId))[0].error, /No listings found/);
  checks.push('Parser failures and empty pages are not retried and keep previous listings');

  // 6. Network failures retry through the queue, then succeed on the same run record.
  const timeout = Object.assign(Error('The operation timed out'), { name: 'TimeoutError' });
  responses.park = timeout;
  jobId = await send('park', { retryDelay: 0, retryBackoff: false });
  [job] = await boss.fetch(COLLECTION_QUEUE, { includeMetadata: true });
  await assert.rejects(runCollection('park', job, deps), /timed out/);
  assert.equal((await runRow(jobId))[0].status, 'retrying');
  await boss.fail(COLLECTION_QUEUE, jobId, { reason: 'timeout' });
  responses.park = [listing('park', 'p5-park')];
  [job] = await boss.fetch(COLLECTION_QUEUE, { includeMetadata: true });
  assert.equal(job.id, jobId);
  assert.equal(job.retryCount, 1);
  result = await runCollection('park', job, deps);
  await boss.complete(COLLECTION_QUEUE, jobId);
  assert.equal(result.status, 'ok');
  [row] = await runRow(jobId);
  assert.equal(row.status, 'ok');
  assert.equal(row.attempts, 2);
  // The last allowed attempt records the error instead of retrying again.
  responses.park = timeout;
  const finalJob = {
    id: 'final-attempt',
    data: { trigger: 'schedule' },
    retryCount: 2,
    retryLimit: 2,
  };
  assert.equal((await runCollection('park', finalJob, deps)).status, 'error');
  checks.push('Network failures retry on the same run, final attempt records the error');

  // 7. Free swim cancels sessions that disappear from the published schedule.
  responses['winnipeg-free-swim'] = [
    listing('winnipeg-free-swim', 'p5-swim-1'),
    listing('winnipeg-free-swim', 'p5-swim-2'),
  ];
  jobId = await send('winnipeg-free-swim');
  [job] = await boss.fetch(COLLECTION_QUEUE, { includeMetadata: true });
  await runCollection('winnipeg-free-swim', job, deps);
  await boss.complete(COLLECTION_QUEUE, jobId);
  responses['winnipeg-free-swim'] = [listing('winnipeg-free-swim', 'p5-swim-1')];
  jobId = await send('winnipeg-free-swim');
  [job] = await boss.fetch(COLLECTION_QUEUE, { includeMetadata: true });
  result = await runCollection('winnipeg-free-swim', job, deps);
  await boss.complete(COLLECTION_QUEUE, jobId);
  assert.equal(result.counts.cancelled, 1);
  assert.equal((await payload('p5-swim-2')).status, 'cancelled');
  assert.equal(await repo.detail('p5-swim-2', { principal: owner }), null);
  checks.push('Free swim sessions missing from the schedule are cancelled, not deleted');

  // 8. A worker that dies mid-run loses its lease; the job is picked up again and finishes once.
  responses.attractions = [listing('attractions', 'p5-place', { type: 'Place' })];
  jobId = await send('attractions', { expireInSeconds: 1, retryDelay: 0, retryBackoff: false });
  [job] = await boss.fetch(COLLECTION_QUEUE, { includeMetadata: true });
  await ensureSource(pool, 'attractions');
  await pool.query(
    "INSERT INTO collection_runs(source, status, trigger, job_id, attempts, started_at) VALUES ('attractions', 'running', 'schedule', $1, 1, now())",
    [jobId],
  ); // the crashed attempt left a running row
  await sleep(1500);
  await boss.supervise(COLLECTION_QUEUE);
  [job] = await boss.fetch(COLLECTION_QUEUE, { includeMetadata: true });
  assert.equal(job.id, jobId);
  result = await runCollection('attractions', job, deps);
  await boss.complete(COLLECTION_QUEUE, jobId);
  const rows = await runRow(jobId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].attempts, 2);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM listings WHERE id = 'p5-place'")).rows[0].n,
    1,
  );
  checks.push('Expired lease recovered; retried job finishes once without duplicates');

  // 9. The real worker loop processes a queued job end to end.
  responses.manitoba = [listing('manitoba', 'p5-mb')];
  await boss.work(
    COLLECTION_QUEUE,
    { includeMetadata: true, pollingIntervalSeconds: 0.5 },
    async ([next]) => runCollection(next.data.sourceId, next, deps),
  );
  const [queued] = await enqueueCollection(boss, pool, ['manitoba'], 'manual');
  for (let i = 0; i < 40 && (await runRow(queued.jobId))[0].status !== 'ok'; i++) await sleep(250);
  assert.equal((await runRow(queued.jobId))[0].status, 'ok');
  await boss.offWork(COLLECTION_QUEUE);
  checks.push('Worker loop collects a manually queued job');

  // 10. Schedules: one per source in Winnipeg time, correct across daylight-saving changes,
  //     and removed when schedules are disabled.
  await syncSchedules(boss, { WINNIGO_SCHEDULES: 'enabled' });
  const schedules = await boss.getSchedules(COLLECTION_QUEUE);
  assert.equal(schedules.length, Object.keys(SCHEDULES).length);
  assert.ok(schedules.every((schedule) => schedule.timezone === TIMEZONE));
  const preview = (cron, from) =>
    boss
      .previewSchedule(cron, { tz: TIMEZONE, from: new Date(from), count: 4 })
      .map((d) => d.toISOString());
  // Fall back (Nov 1, 2026): 06:00 CDT = 11:00Z before, 06:00 CST = 12:00Z after.
  assert.deepEqual(preview(SCHEDULES.forks, '2026-10-31T00:00:00Z').slice(0, 2), [
    '2026-10-31T11:00:00.000Z',
    '2026-11-01T12:00:00.000Z',
  ]);
  // Spring forward (Mar 14, 2027): 06:00 CST = 12:00Z before, 06:00 CDT = 11:00Z after.
  assert.deepEqual(preview(SCHEDULES.forks, '2027-03-13T00:00:00Z').slice(0, 2), [
    '2027-03-13T12:00:00.000Z',
    '2027-03-14T11:00:00.000Z',
  ]);
  // Free swim runs at 06:00 and 15:00 local.
  assert.deepEqual(preview(SCHEDULES['winnipeg-free-swim'], '2026-10-20T00:00:00Z').slice(0, 2), [
    '2026-10-20T11:00:00.000Z',
    '2026-10-20T20:00:00.000Z',
  ]);
  checks.push('Schedules registered per source in America/Winnipeg, correct across DST');

  // 11. After three days of downtime the scheduler sends one catch-up job per source, not three.
  await pool.query(`DELETE FROM ${jobsSchema}.job WHERE name = $1`, [COLLECTION_QUEUE]);
  await pool.query(`UPDATE ${jobsSchema}.schedule SET created_on = now() - interval '3 days'`);
  await pool.query(`UPDATE ${jobsSchema}.version SET cron_on = now() - interval '3 days'`);
  const scheduler = bossFor({
    worker: true,
    cronMonitorIntervalSeconds: 1,
    cronWorkerIntervalSeconds: 1,
  });
  await scheduler.start();
  const scheduledJobs = async () =>
    (
      await pool.query(
        `SELECT data->>'sourceId' AS source, count(*)::int AS n FROM ${jobsSchema}.job WHERE name = $1 GROUP BY 1`,
        [COLLECTION_QUEUE],
      )
    ).rows;
  for (let i = 0; i < 40 && (await scheduledJobs()).length < Object.keys(SCHEDULES).length; i++)
    await sleep(250);
  await sleep(2500); // further passes must not add more
  const caughtUp = await scheduledJobs();
  await scheduler.stop({ graceful: false });
  assert.equal(caughtUp.length, Object.keys(SCHEDULES).length);
  assert.ok(
    caughtUp.every((entry) => entry.n === 1),
    JSON.stringify(caughtUp),
  );
  await syncSchedules(boss, {});
  assert.equal((await boss.getSchedules(COLLECTION_QUEUE)).length, 0);
  checks.push('Downtime catch-up sends one job per source; disabling removes schedules');

  console.log('P5 integration passed:\n- ' + checks.join('\n- '));
} finally {
  await boss?.stop({ graceful: false }).catch(() => {});
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.query(`DROP SCHEMA IF EXISTS ${jobsSchema} CASCADE`);
  await admin.end();
}
