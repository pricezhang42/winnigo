// P5 integration check (npm run check:p5): collection jobs against a temporary PostgreSQL schema
// and a temporary pg-boss schema. Sites and the extraction model are stubbed, so no live website
// or model is contacted.
// Must be the first import: the synthetic sessions are dated November 2026.
import './check-p5-clock.mjs';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
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
import { single } from './fixtures/event-extraction.mjs';

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
const bossFor = (options = {}) =>
  createBoss({ connectionString: config.connectionString, schema: jobsSchema, ...options });

// The Forks (a single-page event source): `site[url]` is its HTML, or an Error to throw.
const forks = 'https://www.theforks.com/events/calendar-of-events';
const site = {};
const fetchImpl = async (url) => {
  const page = site[String(url)];
  if (page instanceof Error) throw page;
  return page === undefined ? new Response('missing', { status: 404 }) : new Response(page);
};
const concert = '<main><h1>QA Concert</h1><p>November 20, 2026 at 7 PM</p><p>QA Hall</p></main>';
// A stub model that answers from the synthetic page and counts its calls.
let modelCalls = 0;
const extractor = {
  model: 'qa-model',
  extractionVersion: 'qa',
  async extract() {
    modelCalls++;
    return { result: structuredClone(single), estimatedCostUsd: 0.001 };
  },
};
// The Forks places page (a listings source).
const places = await readFile('scripts/fixtures/pages/forks-attractions.html', 'utf8');
let placesPage = places;
const fetchPage = async () => {
  if (placesPage instanceof Error) throw placesPage;
  return placesPage;
};
const deps = { pool, repository: repo, fetchImpl, fetchPage, extractor, pauseMs: 0 };
const runRow = async (jobId) =>
  (await pool.query('SELECT * FROM collection_runs WHERE job_id = $1', [jobId])).rows;
const report = async (id) =>
  (await pool.query('SELECT report FROM sources WHERE id = $1', [id])).rows[0]?.report;
const send = (sourceId, options = {}) =>
  boss.send(COLLECTION_QUEUE, { sourceId, trigger: 'schedule' }, options);
const active = Object.keys(SCHEDULES).filter((id) => id !== 'winnipeg-rotary');

const checks = [];
let boss;
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  for (const file of (await readdir('migrations/postgres'))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    await pool.query(await readFile('migrations/postgres/' + file, 'utf8'));
  boss = bossFor({ migrate: true });
  await boss.start();
  await ensureCollectionQueue(boss);
  await ensureCollectionQueue(boss); // second call updates settings without error

  // 1. Manual refresh queues one job per source and never duplicates a queued one; blocked,
  //    paused and unknown sources are refused.
  const [first] = await enqueueCollection(boss, pool, ['forks'], 'manual');
  assert.ok(first.jobId && first.runId);
  assert.equal((await runRow(first.jobId))[0].status, 'queued');
  const [again] = await enqueueCollection(boss, pool, ['forks'], 'manual');
  assert.equal(again.alreadyQueued, true);
  for (const refused of ['facebook', 'wag', 'winnipeg-rotary'])
    await assert.rejects(enqueueCollection(boss, pool, [refused]), /Unknown source/);
  checks.push('Refresh queues jobs; duplicates and unknown, blocked or paused sources refused');

  // 2. An event source run crawls, extracts and publishes, then records the run and report.
  site[forks] = concert;
  let [job] = await boss.fetch(COLLECTION_QUEUE, { includeMetadata: true });
  let result = await runCollection('forks', job, deps);
  await boss.complete(COLLECTION_QUEUE, job.id);
  assert.equal(result.status, 'ok');
  assert.equal(result.counts.new, 1);
  let [run] = await runRow(job.id);
  assert.deepEqual([run.status, run.attempts, !!run.finished_at], ['ok', 1, true]);
  assert.equal((await report('forks')).count, 1);
  const owner = { userId: 'p5-owner', role: 'owner' };
  const page = await repo.search({ principal: owner, query: 'QA Concert' });
  assert.equal(page.total, 1);
  assert.equal(page.items[0].occurrences[0].startAt, '2026-11-21T01:00:00.000Z');
  checks.push('Event source run publishes extracted events and records the run and report');

  // 3. An unchanged page reuses its stored extraction: no model call, nothing changed.
  const calls = modelCalls;
  let jobId = await send('forks');
  [job] = await boss.fetch(COLLECTION_QUEUE, { includeMetadata: true });
  result = await runCollection('forks', job, deps);
  await boss.complete(COLLECTION_QUEUE, jobId);
  assert.equal(modelCalls, calls);
  assert.deepEqual([result.counts.reused, result.counts.unchanged, result.counts.new], [1, 1, 0]);
  checks.push('Unchanged pages reuse stored extractions without a model call');

  // 4. Places: saved as listings; a rerun keeps owner corrections and counts nothing changed.
  jobId = await send('attractions');
  [job] = await boss.fetch(COLLECTION_QUEUE, { includeMetadata: true });
  result = await runCollection('attractions', job, deps);
  await boss.complete(COLLECTION_QUEUE, jobId);
  assert.equal(result.status, 'ok');
  assert.ok(result.counts.added > 5);
  const placeId = (await pool.query("SELECT id FROM listings WHERE source='attractions' LIMIT 1"))
    .rows[0].id;
  await applyAction({ action: 'update', id: placeId, title: 'Owner place title' }, repo, owner);
  jobId = await send('attractions');
  [job] = await boss.fetch(COLLECTION_QUEUE, { includeMetadata: true });
  result = await runCollection('attractions', job, deps);
  await boss.complete(COLLECTION_QUEUE, jobId);
  assert.deepEqual([result.counts.added, result.counts.updated], [0, 0]);
  assert.equal((await repo.detail(placeId, { principal: owner })).title, 'Owner place title');
  checks.push('Places are saved as listings; reruns keep owner corrections');

  // 5. A page layout change (no places found) fails without retrying and keeps the listings.
  placesPage = '<html>redesigned</html>';
  jobId = await send('attractions', { retryLimit: 2 });
  [job] = await boss.fetch(COLLECTION_QUEUE, { includeMetadata: true });
  result = await runCollection('attractions', job, deps);
  await boss.complete(COLLECTION_QUEUE, jobId);
  assert.equal(result.status, 'error');
  assert.equal((await report('attractions')).status, 'error');
  assert.ok((await pool.query("SELECT 1 FROM listings WHERE source='attractions'")).rowCount > 5);
  placesPage = places;
  checks.push('Layout changes fail without retrying and keep earlier listings');

  // 6. Network failures retry through the queue on the same run record; the last allowed
  //    attempt records the error instead.
  site[forks] = new TypeError('fetch failed');
  jobId = await send('forks', { retryLimit: 1, retryDelay: 0, retryBackoff: false });
  [job] = await boss.fetch(COLLECTION_QUEUE, { includeMetadata: true });
  await assert.rejects(runCollection('forks', job, deps), /fetch failed/);
  await boss.fail(COLLECTION_QUEUE, jobId, { message: 'fetch failed' });
  assert.equal((await runRow(jobId))[0].status, 'retrying');
  [job] = await boss.fetch(COLLECTION_QUEUE, { includeMetadata: true });
  assert.equal(job.id, jobId);
  result = await runCollection('forks', job, deps);
  await boss.complete(COLLECTION_QUEUE, jobId);
  assert.equal(result.status, 'error');
  [run] = await runRow(jobId);
  assert.deepEqual([run.status, run.attempts], ['error', 2]);
  assert.equal((await repo.search({ principal: owner, query: 'QA Concert' })).total, 1);
  site[forks] = concert;
  checks.push('Network failures retry on the same run; the final attempt records the error');

  // 7. A worker that dies mid-run loses its lease; the job is picked up again and finishes once.
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
  assert.deepEqual([rows[0].status, rows[0].attempts], ['ok', 2]);
  checks.push('Expired lease recovered; retried job finishes once without duplicates');

  // 8. The real worker loop processes a queued job end to end.
  await boss.work(
    COLLECTION_QUEUE,
    { includeMetadata: true, pollingIntervalSeconds: 0.5 },
    async ([next]) => runCollection(next.data.sourceId, next, deps),
  );
  const [queued] = await enqueueCollection(boss, pool, ['forks'], 'manual');
  for (let i = 0; i < 40 && (await runRow(queued.jobId))[0].status !== 'ok'; i++) await sleep(250);
  assert.equal((await runRow(queued.jobId))[0].status, 'ok');
  await boss.offWork(COLLECTION_QUEUE);
  checks.push('Worker loop collects a manually queued job');

  // 9. Schedules: one per active source in Winnipeg time, correct across daylight-saving changes,
  //     and removed when schedules are disabled.
  await syncSchedules(boss, { WINNIGO_SCHEDULES: 'enabled' });
  const schedules = await boss.getSchedules(COLLECTION_QUEUE);
  // Paused sources (Rotary) keep their cron entry but are not scheduled.
  assert.deepEqual(schedules.map((schedule) => schedule.key).sort(), [...active].sort());
  assert.ok(schedules.every((schedule) => schedule.timezone === TIMEZONE));
  // Event sources keep their longer lease when a schedule sends the job.
  const forksSchedule = schedules.find((schedule) => schedule.key === 'forks');
  assert.equal(forksSchedule.options.expireInSeconds, 3600);
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

  // 10. After three days of downtime the scheduler sends one catch-up job per source, not three.
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
  for (let i = 0; i < 40 && (await scheduledJobs()).length < active.length; i++) await sleep(250);
  await sleep(2500); // further passes must not add more
  const caughtUp = await scheduledJobs();
  await scheduler.stop({ graceful: false });
  assert.equal(caughtUp.length, active.length);
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
