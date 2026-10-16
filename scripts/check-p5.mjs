// P5 integration check (npm run check:p5): collection jobs against a temporary PostgreSQL schema
// and a temporary pg-boss schema. Sources are faked, so no live website is contacted.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { serviceConfig } from './check-services.mjs';
import { PostgresRepository } from '../lib/server/postgres-repository.mjs';
import { collectWag } from '../lib/server/wag.mjs';
import { parseClcFeed } from '../lib/server/canada-life-centre.mjs';
import { collectMuseum } from '../lib/server/museum.mjs';
import { placeholderDescription } from '../lib/connectors.mjs';
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
  const stamp = (items) => items.map((item) => ({ ...item, checkedAt }));
  return Array.isArray(response) ? stamp(response) : { ...response, items: stamp(response.items) };
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
  (await pool.query('SELECT payload FROM listing_source_records WHERE id = $1', [id])).rows[0]
    ?.payload;
const audits = async (action) =>
  (await pool.query('SELECT count(*)::int AS n FROM audit_records WHERE action = $1', [action]))
    .rows[0].n;

const checks = [];
let boss;
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  for (const file of [
    '0001_foundation.sql',
    '0002_discovery.sql',
    '0003_accounts.sql',
    '0004_restrict_community.sql',
    '0005_collection_runs.sql',
    '0006_event_occurrences.sql',
    '0007_typed_occurrence_schedule.sql',
    '0008_exhibition_visiting_cards.sql',
    '0009_typed_listing_fields.sql',
  ])
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
  assert.deepEqual(result.counts, {
    found: 2,
    added: 2,
    updated: 0,
    unchanged: 0,
    cancelled: 0,
    merged: 0,
    rejected: 0,
    pages: 1,
    eventPages: 0,
  });
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
  assert.deepEqual(result.counts, {
    found: 2,
    added: 0,
    updated: 0,
    unchanged: 2,
    cancelled: 0,
    merged: 0,
    rejected: 0,
    pages: 1,
    eventPages: 0,
  });
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

  // 7b. Step 2 guards: invalid listings are rejected, partial reads never cancel, and a sharp drop
  //     is flagged and skips cancellation.
  const runOnce = async (sourceId) => {
    const id = await send(sourceId);
    const [next] = await boss.fetch(COLLECTION_QUEUE, { includeMetadata: true });
    const outcome = await runCollection(sourceId, next, deps);
    await boss.complete(COLLECTION_QUEUE, id);
    return { outcome, row: (await runRow(id))[0] };
  };
  responses.park = [
    listing('park', 'p5-park'),
    listing('park', 'p5-bad-date', { start: '2026-02-30' }),
    listing('park', 'p5-backwards', { start: '2026-05-02', end: '2026-05-01' }),
    listing('park', 'p5-no-title', { title: ' ' }),
    listing('park', 'p5-bad-url', { url: 'javascript:alert(1)' }),
  ];
  let { outcome, row: guarded } = await runOnce('park');
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.counts.rejected, 4);
  assert.match(guarded.error, /4 listing\(s\) rejected/);
  assert.equal(await payload('p5-bad-date'), undefined);
  responses.park = [listing('park', 'p5-bad-date', { start: '2026-02-30' })];
  ({ outcome, row: guarded } = await runOnce('park'));
  assert.equal(outcome.status, 'error');
  assert.match(guarded.error, /failed validation/);

  const sessions = Array.from({ length: 12 }, (_, n) =>
    listing('winnipeg-free-swim', 'p5-pool-' + n),
  );
  responses['winnipeg-free-swim'] = sessions;
  await runOnce('winnipeg-free-swim');
  // A later page failed: what was read is saved, nothing is cancelled.
  responses['winnipeg-free-swim'] = {
    items: sessions.slice(0, 8),
    pagesRead: 1,
    failedPages: [{ url: 'https://example.test/2', error: 'Source returned HTTP 503' }],
  };
  ({ outcome, row: guarded } = await runOnce('winnipeg-free-swim'));
  assert.equal(outcome.status, 'partial');
  assert.equal(outcome.counts.cancelled, 0);
  assert.match(guarded.error, /page\(s\) unavailable/);
  assert.equal((await payload('p5-pool-11')).status, 'active');
  // A sharp drop (4 of 12) is flagged and cancels nothing.
  responses['winnipeg-free-swim'] = sessions.slice(0, 4);
  ({ outcome, row: guarded } = await runOnce('winnipeg-free-swim'));
  assert.equal(outcome.status, 'warning');
  assert.equal(outcome.counts.cancelled, 0);
  assert.match(guarded.error, /down from 12; cancellations skipped/);
  assert.equal((await payload('p5-pool-11')).status, 'active');
  // A normal shrink (11 of 12) still cancels the missing session.
  responses['winnipeg-free-swim'] = sessions.slice(0, 11);
  ({ outcome } = await runOnce('winnipeg-free-swim'));
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.counts.cancelled, 1);
  assert.equal((await payload('p5-pool-11')).status, 'cancelled');
  checks.push('Invalid listings rejected; partial reads and sharp drops never cancel sessions');

  // 7c. Stored descriptions reach the collector so event pages are read only for new events;
  //     placeholders are not treated as descriptions.
  responses.manitoba = [
    listing('manitoba', 'p5-described', { description: 'A real summary.' }),
    listing('manitoba', 'p5-placeholder', {
      description: placeholderDescription('Travel Manitoba'),
    }),
  ];
  await runOnce('manitoba');
  const known = await repo.knownDescriptions('manitoba');
  assert.equal(known.get('https://example.test/p5-described'), 'A real summary.');
  assert.equal(known.has('https://example.test/p5-placeholder'), false);
  let received;
  const capturing = async (source, checkedAt, options) => {
    received = options.knownDescriptions;
    return collect(source, checkedAt);
  };
  jobId = await send('manitoba');
  [job] = await boss.fetch(COLLECTION_QUEUE, { includeMetadata: true });
  await runCollection('manitoba', job, { ...deps, collect: capturing });
  await boss.complete(COLLECTION_QUEUE, jobId);
  assert.equal(received.get('https://example.test/p5-described'), 'A real summary.');
  checks.push('Stored descriptions are passed to the collector; placeholders excluded');

  // 7d. Copies of the same page under older, date-based IDs are merged into the stable ID and
  //     deleted: the owner's edit, an access grant and the history move to the survivor.
  const pageUrl = 'https://example.test/boo-at-the-zoo/info';
  const oldCopies = ['park-info-2026-10-02', 'park-info-2026-10-08'];
  await repo.importRecords(
    oldCopies.map((id) => ({
      id,
      source: 'park',
      payload: listing('park', id, { url: pageUrl, title: 'Boo at the Zoo' }),
      hidden: false,
      override: {},
    })),
  );
  await applyAction({ action: 'update', id: oldCopies[0], title: 'Owner Boo' }, repo, owner);
  await pool.query(
    "INSERT INTO auth_user(id, name, email, \"emailVerified\", \"updatedAt\") VALUES ('p5-user', 'P5', 'p5@example.test', true, now())",
  );
  await pool.query("INSERT INTO listing_grants(user_id, listing_id) VALUES ('p5-user', $1)", [
    oldCopies[1],
  ]);
  // A page the source no longer lists, also stored twice.
  const gone = 'https://example.test/finished-event';
  await repo.importRecords(
    ['park-gone-2026-09-01', 'park-gone-2026-09-05'].map((id) => ({
      id,
      source: 'park',
      payload: listing('park', id, { url: gone, title: 'Finished event' }),
      hidden: false,
      override: {},
    })),
  );
  responses.park = [
    listing('park', 'park-boo-at-the-zoo-info', { url: pageUrl, title: 'Boo at the Zoo' }),
    listing('park', 'p5-park'),
  ];
  ({ outcome } = await runOnce('park'));
  assert.equal(outcome.counts.merged, 3);
  const rowsFor = async (url) =>
    (await pool.query('SELECT id FROM listings WHERE source_url = $1', [url])).rows.map(
      (row) => row.id,
    );
  assert.deepEqual(await rowsFor(pageUrl), ['park-boo-at-the-zoo-info']);
  assert.equal((await rowsFor(gone)).length, 1);
  assert.equal(
    (await repo.detail('park-boo-at-the-zoo-info', { admin: true, principal: owner })).title,
    'Owner Boo',
  );
  assert.equal(
    (await pool.query("SELECT 1 FROM listing_grants WHERE listing_id = 'park-boo-at-the-zoo-info'"))
      .rowCount,
    1,
  );
  assert.equal(
    (await pool.query('SELECT 1 FROM audit_records WHERE listing_id = ANY($1)', [oldCopies]))
      .rowCount,
    0,
  );
  assert.equal(
    (await pool.query('SELECT 1 FROM source_identities WHERE listing_id = ANY($1)', [oldCopies]))
      .rowCount,
    0,
  );
  checks.push('Same-page copies merged into the stable ID and deleted; edits and grants kept');

  // WAG's real parser flows through storage without duplicating records or losing edits.
  const wagCalendar = (await readFile('scripts/fixtures/wag/calendar.html', 'utf8')).replace(
    'class="btn-more"',
    'class="unused"',
  );
  const wagEvent =
    '<meta property="og:image" content="https://www.wag.ca/isl/uploads/2026/10/qa-art.jpg">' +
    (await readFile('scripts/fixtures/wag/event.html', 'utf8'));
  const wagResult = await collectWag(
    { id: 'wag', name: 'WAG–Qaumajuq', url: 'https://www.wag.ca/events/event-calendar/' },
    '2026-10-11T12:00:00Z',
    {
      pauseMs: 0,
      fetchPage: async (url) => ({ body: url.includes('/event/') ? wagEvent : wagCalendar }),
    },
  );
  responses.wag = wagResult;
  ({ outcome } = await runOnce('wag'));
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.counts.added, 1);
  const wagId = wagResult.items[0].id;
  assert.deepEqual((await payload(wagId)).images, [
    'https://www.wag.ca/isl/uploads/2026/10/qa-art.jpg',
  ]);
  assert.equal((await payload(wagId)).image, wagResult.items[0].images[0]);
  await applyAction({ action: 'update', id: wagId, title: 'Owner WAG title' }, repo, owner);
  ({ outcome } = await runOnce('wag'));
  assert.equal(outcome.counts.unchanged, 1);
  assert.equal(outcome.counts.added, 0);
  assert.equal(
    (await repo.detail(wagId, { admin: true, principal: owner })).title,
    'Owner WAG title',
  );
  // Retire an existing landing page from discovery and keep its editable history.
  const parentHtml = wagEvent
    .replace('Nov 6 - Nov 8', 'Multiple Dates/Ages Available')
    .replace(
      '<div class="widget"><p>SOLD OUT!</p>',
      '<div class="widget"><h3>Choose from:</h3><a href="/event/qa-class/">Weekly class</a></div><div class="widget"><p>SOLD OUT!</p>',
    );
  const childHtml = wagEvent.replace(
    'Nov 6 - Nov 8',
    'Sep 20 - Nov 29<div> Sundays<br>*No classes Oct 11</div>',
  );
  const classes = await collectWag(
    { id: 'wag', name: 'WAG–Qaumajuq', url: 'https://www.wag.ca/events/event-calendar/' },
    '2026-10-11T12:00:00Z',
    {
      pauseMs: 0,
      fetchPage: async (url) => ({
        body: url.includes('/qa-class/')
          ? childHtml
          : url.includes('/event/')
            ? parentHtml
            : wagCalendar.replace("Nov 6 Nov 8 '26", 'Multiple Dates/Ages Available'),
      }),
    },
  );
  responses.wag = classes;
  ({ outcome } = await runOnce('wag'));
  assert.equal(outcome.counts.added, 1);
  assert.equal(
    (await pool.query('SELECT hidden FROM listings WHERE id = $1', [wagId])).rows[0].hidden,
    true,
  );
  assert.equal(await repo.detail(wagId, { principal: owner }), null);
  assert.equal(
    (await repo.detail(wagId, { admin: true, principal: owner })).title,
    'Owner WAG title',
  );
  const childId = classes.items.find((item) => item.parentUrl).id;
  assert.equal((await payload(childId)).start, '2026-09-20');
  assert.equal((await payload(childId)).yearAssumed, true);
  assert.match((await payload(childId)).scheduleText, /No classes Oct 11/);
  ({ outcome } = await runOnce('wag'));
  assert.equal(outcome.counts.added, 0);
  assert.equal(outcome.counts.unchanged, 1);
  checks.push(
    'WAG class expansion hides the parent, preserves edits, and persists default-year dates',
  );
  responses.wag = {
    ...wagResult,
    reviewRequired: 1,
    failedPages: [{ url: 'https://www.wag.ca/event/conflict/', error: 'Dates conflict' }],
  };
  ({ outcome, row: guarded } = await runOnce('wag'));
  assert.equal(outcome.status, 'partial');
  assert.equal(outcome.counts.reviewRequired, 1);
  assert.match(guarded.error, /withheld for date review/);
  responses.wag = Error('WAG calendar layout changed');
  ({ outcome } = await runOnce('wag'));
  assert.equal(outcome.status, 'error');
  assert.equal((await payload(wagId)).status, 'active');
  checks.push('WAG parser imports idempotently; edits and records survive partial/failed runs');

  // Museum series keeps month precision, history and private-photo-ready source metadata.
  const museumDetail = await readFile('scripts/fixtures/museum/exhibition.html', 'utf8');
  const museumEntry = {
    '@type': 'Event',
    name: 'Paper exhibition',
    url: 'https://manitobamuseum.ca/event/paper/2026-10-15/',
    startDate: '2026-10-15T10:00:00-05:00',
    endDate: '2026-10-15T16:00:00-05:00',
  };
  const museumMonth =
    '<div data-view="month"></div><script type="application/ld+json">' +
    JSON.stringify([museumEntry]) +
    '</script>';
  const museumResult = await collectMuseum(
    { id: 'manitoba-museum', name: 'Manitoba Museum', url: 'https://manitobamuseum.ca/whats-on/' },
    '2026-10-14T12:00:00Z',
    {
      pauseMs: 0,
      fetchImpl: async (url) => new Response(url.includes('/month/') ? museumMonth : museumDetail),
    },
  );
  responses['manitoba-museum'] = museumResult;
  ({ outcome } = await runOnce('manitoba-museum'));
  assert.equal(outcome.counts.added, 1);
  assert.equal(outcome.counts.occurrences, 1);
  const museumId = museumResult.items[0].id;
  assert.equal((await payload(museumId)).endMonth, '2027-04');
  assert.equal((await payload(museumId)).end, undefined);
  const museumOccurrence = (
    await pool.query(
      'SELECT start_date::text,end_date::text,start_at,end_at,time_zone,status,source_url,details FROM occurrences WHERE listing_id=$1',
      [museumId],
    )
  ).rows[0];
  assert.equal(museumOccurrence.end_date, '2026-10-15');
  assert.equal(museumOccurrence.details.endMonth, undefined);
  assert.equal(museumOccurrence.start_at.toISOString(), '2026-10-15T15:00:00.000Z');
  assert.equal(museumOccurrence.time_zone, 'America/Winnipeg');
  assert.equal(museumOccurrence.details.publishedStart, '2026-10-15T10:00:00-05:00');
  assert.equal(museumOccurrence.details.startAt, undefined);
  assert.equal(
    (await repo.knownSourceListings('manitoba-museum')).get(museumId).runDates.endMonth,
    '2027-04',
  );
  await applyAction(
    { action: 'update', id: museumId, title: 'Owner Museum title', hidden: true },
    repo,
    owner,
  );
  ({ outcome } = await runOnce('manitoba-museum'));
  assert.equal(outcome.counts.added, 0);
  const editedMuseum = await repo.detail(museumId, { admin: true, principal: owner });
  assert.equal(editedMuseum.title, 'Owner Museum title');
  assert.equal(editedMuseum.status, 'hidden');
  assert.equal(await repo.detail(museumId, { principal: owner }), null);
  // Month-only expiry compares month precision without converting it to an invented day.
  await repo.applySourceCollection(
    'manitoba-museum',
    [
      {
        ...museumResult.items[0],
        id: 'museum-expired',
        url: 'https://manitobamuseum.ca/event/expired/',
        endMonth: '2020-04',
        start: '2020-01-01',
      },
    ],
    { checkedAt: new Date().toISOString() },
  );
  assert.equal(await repo.detail('museum-expired', { principal: owner }), null);
  assert.ok(await repo.detail('museum-expired', { admin: true, principal: owner }));
  responses['manitoba-museum'] = {
    ...museumResult,
    failedPages: [
      { url: 'https://manitobamuseum.ca/whats-on/month/2026-11/', error: 'Unavailable' },
    ],
  };
  ({ outcome } = await runOnce('manitoba-museum'));
  assert.equal(outcome.status, 'partial');
  assert.equal((await payload(museumId)).endMonth, '2027-04');
  checks.push(
    'Museum groups persist, retain owner edits/hidden state, and expire at month precision',
  );

  // Recurring sessions share the ordinary listing/occurrence tables and survive same-URL imports.
  const programUrl = 'https://manitobamuseum.ca/event/program/';
  const summary = listing('manitoba-museum', 'manitoba-museum-event-program', {
    url: programUrl,
    schedule: 'series',
    start: undefined,
    title: 'Program',
  });
  await repo.applySourceCollection('manitoba-museum', [summary], {
    checkedAt: new Date().toISOString(),
  });
  await applyAction({ action: 'update', id: summary.id, title: 'Owner summary note' }, repo, owner);
  const programDetail = await readFile('scripts/fixtures/museum/event.html', 'utf8');
  const programEntries = [
    '2026-10-02T10:00:00-05:00',
    '2026-11-06T10:00:00-06:00',
    '2026-11-06T13:00:00-06:00',
  ].map((startDate) => ({
    ...museumEntry,
    name: 'Program',
    url: programUrl,
    startDate,
    endDate: startDate.replace(/T\d\d:/, 'T16:'),
  }));
  const programResult = await collectMuseum(
    { id: 'manitoba-museum', url: 'https://manitobamuseum.ca/whats-on/' },
    '2026-10-15T12:00:00Z',
    {
      pauseMs: 0,
      knownListings: await repo.knownSourceListings('manitoba-museum'),
      fetchImpl: async (url) =>
        new Response(
          url.includes('/month/')
            ? '<div data-view="month"></div><script type="application/ld+json">' +
                JSON.stringify(programEntries) +
                '</script>'
            : programDetail,
        ),
    },
  );
  assert.equal(programResult.items.length, 3);
  responses['manitoba-museum'] = programResult;
  ({ outcome } = await runOnce('manitoba-museum'));
  assert.equal(outcome.counts.added, 0);
  assert.equal(outcome.counts.found, 1);
  assert.equal(outcome.counts.merged, 0);
  const oldSummary = await repo.detail(summary.id, { admin: true, principal: owner });
  assert.equal(oldSummary.status, 'active');
  assert.equal(oldSummary.occurrences.length, 3);
  assert.equal(oldSummary.title, 'Owner summary note');
  for (const item of programResult.items) {
    assert.equal(await payload(item.id), undefined);
    const session = (
      await pool.query(
        'SELECT start_at,end_at,details FROM occurrences WHERE listing_id=$1 AND occurrence_id=$2',
        [summary.id, item.id],
      )
    ).rows[0];
    assert.equal(session.details.title, undefined);
    assert.equal(session.details.description, undefined);
    assert.equal(session.start_at.toISOString(), new Date(item.startAt).toISOString());
    assert.equal(session.end_at.toISOString(), new Date(item.endAt).toISOString());
  }
  const sessionId = programResult.items[1].id;
  await applyAction(
    { action: 'update', id: sessionId, title: 'Owner session title', hidden: true },
    repo,
    owner,
  );
  ({ outcome } = await runOnce('manitoba-museum'));
  assert.equal(outcome.counts.added, 0);
  assert.equal(outcome.counts.merged, 0);
  assert.equal(
    (await repo.detail(sessionId, { admin: true, principal: owner })).title,
    'Owner session title',
  );
  assert.equal(await repo.detail(sessionId, { principal: owner }), null);
  // A later partial window must not collapse or cancel saved sessions sharing one URL.
  responses['manitoba-museum'] = {
    ...programResult,
    items: [programResult.items[0]],
    failedPages: [{ url: programUrl, error: 'Unavailable' }],
  };
  ({ outcome } = await runOnce('manitoba-museum'));
  assert.equal(outcome.status, 'partial');
  assert.equal(
    (await repo.detail(programResult.items[2].id, { admin: true, principal: owner })).status,
    'active',
  );
  assert.equal(
    (await repo.detail(programResult.items[2].id, { admin: true, principal: owner })).status,
    'active',
  );
  assert.equal(
    (await repo.detail(programResult.items[1].id, { admin: true, principal: owner })).recurring,
    true,
  );
  checks.push(
    'Museum stores shared event details with lightweight occurrences; session edits and dates survive partial reads',
  );

  // Verified visiting hours use the same persisted intervals as calendar events.
  const hoursId = 'p5-visiting-hours';
  const visitingSchedule = {
    timeZone: 'America/Winnipeg',
    sourceUrl: 'https://example.test/hours',
    checkedAt: '2026-10-16T12:00:00Z',
    periods: [
      {
        from: '2026-10-01',
        to: '2026-11-30',
        weekly: [{ weekdays: [0, 2, 3, 4, 5, 6], opens: '10:00', closes: '16:00' }],
      },
    ],
    exceptions: [
      { from: '2026-10-19', to: '2026-10-19', intervals: [{ opens: '12:00', closes: '17:00' }] },
      { from: '2026-11-11', to: '2026-11-11', closed: true },
    ],
  };
  await repo.applySourceCollection(
    'attractions',
    [
      listing('attractions', hoursId, {
        type: 'Place',
        start: undefined,
        visitingSchedule,
      }),
    ],
    { checkedAt: visitingSchedule.checkedAt },
  );
  for (const [date, status] of [
    ['2026-10-26', 'unavailable'],
    ['2026-10-19', 'available'],
    ['2026-11-11', 'unavailable'],
    ['2026-12-01', 'unknown'],
  ]) {
    assert.equal((await repo.availability(hoursId, date, { principal: owner })).status, status);
    const matches = await repo.search({ query: hoursId, date, principal: owner });
    assert.equal(matches.total, status === 'available' ? 1 : 0);
  }
  const visiting = await repo.detail(hoursId, { principal: owner });
  assert.equal(
    visiting.occurrences.find((o) => o.start === '2026-11-03').startAt,
    '2026-11-03T16:00:00.000Z',
  );
  await applyAction({ action: 'update', id: hoursId, visitingSchedule: null }, repo, owner);
  assert.equal(
    (await repo.availability(hoursId, '2026-10-19', { principal: owner })).status,
    'unknown',
  );
  assert.ok(
    (await repo.detail(hoursId, { principal: owner })).occurrences.some(
      (o) => o.status === 'superseded',
    ),
  );
  checks.push(
    'Persisted visiting hours respect closures, exceptional openings, DST, unknown dates and removed rules',
  );

  // Date-only events stay date-only; constraints reject invalid persisted schedules.
  const dateOnly = (
    await pool.query(
      "SELECT start_at,end_at,start_date::text FROM occurrences WHERE listing_id='p5-a'",
    )
  ).rows[0];
  assert.equal(dateOnly.start_at, null);
  assert.equal(dateOnly.end_at, null);
  assert.equal(dateOnly.start_date, '2099-06-01');
  await assert.rejects(
    pool.query("UPDATE occurrences SET end_date=start_date-1 WHERE listing_id='p5-a'"),
    /occurrence_date_order/,
  );
  await assert.rejects(
    pool.query("UPDATE occurrences SET status='invalid' WHERE listing_id='p5-a'"),
    /occurrence_status/,
  );
  await assert.rejects(
    pool.query("UPDATE occurrences SET start_at=now() WHERE listing_id='p5-a'"),
    /occurrence_timestamp_pair/,
  );
  await assert.rejects(
    pool.query("UPDATE occurrences SET end_at=start_at-interval '1 minute' WHERE listing_id=$1", [
      summary.id,
    ]),
    /occurrence_timestamp_order/,
  );
  checks.push(
    'Typed schedule columns preserve date-only events and enforce valid dates, timestamp pairs/order and status',
  );

  const exhibition = listing('attractions', 'p5-daily-exhibition', {
    schedule: 'series',
    start: '2099-05-01',
    end: undefined,
    endMonth: '2100-04',
    runDates: { start: '2099-05-01', endMonth: '2100-04' },
    occurrenceSamples: [
      { start: '2099-06-01T10:00:00-05:00', end: '2099-06-01T16:00:00-05:00' },
      { start: '2099-06-02T10:00:00-05:00', end: '2099-06-02T16:00:00-05:00' },
    ],
  });
  await repo.applySourceCollection('attractions', [exhibition], {
    checkedAt: new Date().toISOString(),
    preserveHistory: true,
  });
  const dailyCards = await repo.search({ query: 'p5-daily-exhibition', principal: owner });
  assert.equal(dailyCards.total, 2);
  assert.deepEqual(dailyCards.items.map((i) => i.start).sort(), ['2099-06-01', '2099-06-02']);
  assert.ok(
    dailyCards.items.every((i) => i.recurring && i.eventId === exhibition.id && i.start === i.end),
  );
  assert.equal(
    (await repo.search({ query: 'p5-daily-exhibition', date: '2099-06-02', principal: owner }))
      .total,
    1,
  );
  assert.equal(
    (await repo.search({ query: 'p5-daily-exhibition', date: '2099-06-03', principal: owner }))
      .total,
    0,
  );
  assert.equal(
    (await repo.knownSourceListings('attractions')).get(exhibition.id).runDates.endMonth,
    '2100-04',
  );
  checks.push(
    'Exhibitions project separate visiting-day cards from one shared event, preserving overall run bounds',
  );

  // ICS UID identity and per-instance overrides use the same queue and domain tables.
  const clcText = await readFile('scripts/fixtures/clc/calendar.ics', 'utf8');
  const clcResult = parseClcFeed(clcText, '2026-10-16T12:00:00Z');
  responses['canada-life-centre'] = clcResult;
  ({ outcome } = await runOnce('canada-life-centre'));
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.counts.added, 6);
  ({ outcome } = await runOnce('canada-life-centre'));
  assert.equal(outcome.counts.unchanged, 6);
  assert.equal((await repo.search({ query: 'Same-day show', principal: owner })).total, 2);
  const moved = await repo.search({ query: 'Rescheduled concert', principal: owner });
  assert.equal(moved.total, 1);
  const series = clcResult.items.find((e) => e.title === 'Concert series');
  await applyAction({ action: 'update', id: series.id, title: 'Owner CLC series' }, repo, owner);
  assert.equal(
    (await repo.detail(moved.items[0].id, { principal: owner })).title,
    'Owner CLC series',
  );
  await applyAction(
    { action: 'update', id: moved.items[0].id, title: 'Owner CLC session', hidden: true },
    repo,
    owner,
  );
  ({ outcome } = await runOnce('canada-life-centre'));
  assert.equal(outcome.counts.added, 0);
  assert.equal(
    (await repo.detail(moved.items[0].id, { admin: true, principal: owner })).title,
    'Owner CLC session',
  );
  assert.equal(await repo.detail(moved.items[0].id, { principal: owner }), null);
  // Explicit UID rescheduling supersedes only that event's previous date, preserving history.
  responses['canada-life-centre'] = parseClcFeed(
    clcText
      .replace('20261020T190000', '20261021T190000')
      .replace('20261020T200000', '20261021T200000'),
    '2026-10-16T12:00:00Z',
  );
  ({ outcome } = await runOnce('canada-life-centre'));
  assert.equal(outcome.status, 'ok');
  assert.equal(
    (await repo.search({ query: 'Same-day show', date: '2026-10-20', principal: owner })).total,
    1,
  );
  const firstShow = clcResult.items.find((e) => e.title === 'Same-day show');
  assert.equal(
    (
      await pool.query('SELECT status FROM occurrences WHERE listing_id=$1 AND occurrence_id=$2', [
        firstShow.id,
        firstShow.occurrences[0].id,
      ])
    ).rows[0].status,
    'superseded',
  );
  responses['canada-life-centre'] = {
    ...clcResult,
    items: [clcResult.items[1]],
    failedPages: [{ url: 'https://www.canadalifecentre.ca/', error: 'Synthetic partial feed' }],
  };
  ({ outcome } = await runOnce('canada-life-centre'));
  assert.equal(outcome.status, 'partial');
  assert.equal((await repo.search({ query: 'Same-day show', principal: owner })).total, 2);
  responses['canada-life-centre'] = Error('Incomplete or invalid ICS calendar');
  ({ outcome } = await runOnce('canada-life-centre'));
  assert.equal(outcome.status, 'error');
  assert.equal((await repo.search({ query: 'Same-day show', principal: owner })).total, 2);
  assert.equal(SCHEDULES['canada-life-centre'], undefined);
  checks.push(
    'ICS collection preserves UID performances, parent/session edits, moved/excluded dates and partial/failed history; no schedule enabled',
  );

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
