import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_SOURCES } from '../../config/sources.mjs';
import { collectableSources, isTransient } from '../../lib/server/collection.mjs';
import { jobsSchema, scheduledSources, schedulesEnabled } from '../../lib/server/job-queue.mjs';

test('P5 retries network trouble but not source changes', () => {
  const named = (name) => Object.assign(Error('x'), { name });
  assert.equal(isTransient(named('TimeoutError')), true);
  assert.equal(isTransient(named('AbortError')), true);
  assert.equal(isTransient(new TypeError('fetch failed')), true);
  assert.equal(isTransient(Object.assign(Error('x'), { cause: { code: 'ECONNRESET' } })), true);
  assert.equal(isTransient(Error('Source returned HTTP 503')), true);
  assert.equal(isTransient(Error('FlareSolverr returned HTTP 503')), true);
  assert.equal(isTransient(Error('FlareSolverr returned HTTP 403')), false);
  assert.equal(isTransient(Error('Source returned HTTP 429')), true);
  assert.equal(isTransient(Error('Source returned HTTP 404')), false);
  assert.equal(isTransient(Error('Unexpected source size')), false);
  assert.equal(isTransient(Error('No places found; the page may have changed')), false);
  assert.equal(isTransient(Error('Event extraction is not configured')), false);
  assert.equal(isTransient(undefined), false);
});

test('P5 schedules come from the source list and match the agreed times', () => {
  // The schedules that were registered before the source list drove them (2026-11-23). Changing
  // this set changes what runs in production when schedules are enabled: review it deliberately.
  assert.deepEqual(Object.fromEntries(scheduledSources().map((s) => [s.id, s.schedule])), {
    'winnipeg-free-swim': '0 6,15 * * *',
    forks: '0 6 * * *',
    park: '0 6 * * *',
    manitoba: '0 6 * * *',
    attractions: '0 6 * * *',
  });
  const ids = new Set(collectableSources.map((s) => s.id));
  assert.equal(ids.has('facebook'), false);
  for (const source of EVENT_SOURCES.filter((s) => s.status !== 'active'))
    assert.ok(!scheduledSources().some((s) => s.id === source.id), source.id);
});

test('P5 schedules are opt-in and the jobs schema name is validated', () => {
  assert.equal(schedulesEnabled({}), false);
  assert.equal(schedulesEnabled({ WINNIGO_SCHEDULES: 'true' }), false);
  assert.equal(schedulesEnabled({ WINNIGO_SCHEDULES: 'enabled' }), true);
  assert.equal(jobsSchema({}), 'winnigo_jobs');
  assert.throws(() => jobsSchema({ WINNIGO_JOBS_SCHEMA: 'bad; drop' }), /Invalid/);
});
