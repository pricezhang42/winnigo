import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_SOURCES } from '../../config/sources.mjs';
import { collectableSources, isTransient } from '../../lib/server/collection.mjs';
import { SCHEDULES, jobsSchema, schedulesEnabled } from '../../lib/server/job-queue.mjs';

test('P5 retries network trouble but not source changes', () => {
  const named = (name) => Object.assign(Error('x'), { name });
  assert.equal(isTransient(named('TimeoutError')), true);
  assert.equal(isTransient(named('AbortError')), true);
  assert.equal(isTransient(new TypeError('fetch failed')), true);
  assert.equal(isTransient(Object.assign(Error('x'), { cause: { code: 'ECONNRESET' } })), true);
  assert.equal(isTransient(Error('Source returned HTTP 503')), true);
  assert.equal(isTransient(Error('Source returned HTTP 429')), true);
  assert.equal(isTransient(Error('Source returned HTTP 404')), false);
  assert.equal(isTransient(Error('Unexpected source size')), false);
  assert.equal(isTransient(Error('No places found; the page may have changed')), false);
  assert.equal(isTransient(Error('Event extraction is not configured')), false);
  assert.equal(isTransient(undefined), false);
});

test('P5 schedules name collectable sources only and never Facebook or blocked sites', () => {
  const ids = new Set(collectableSources.map((s) => s.id));
  for (const id of Object.keys(SCHEDULES)) assert.ok(ids.has(id), id);
  assert.equal('facebook' in SCHEDULES, false);
  for (const blocked of EVENT_SOURCES.filter((s) => s.status === 'blocked'))
    assert.equal(ids.has(blocked.id), false, blocked.id);
  for (const cron of Object.values(SCHEDULES)) assert.match(cron, /^0 [\d,]+ \* \* \*$/);
});

test('P5 schedules are opt-in and the jobs schema name is validated', () => {
  assert.equal(schedulesEnabled({}), false);
  assert.equal(schedulesEnabled({ WINNIGO_SCHEDULES: 'true' }), false);
  assert.equal(schedulesEnabled({ WINNIGO_SCHEDULES: 'enabled' }), true);
  assert.equal(jobsSchema({}), 'winnigo_jobs');
  assert.throws(() => jobsSchema({ WINNIGO_JOBS_SCHEMA: 'bad; drop' }), /Invalid/);
});
