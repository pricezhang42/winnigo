// Event store check (npm run check:events): publishing, review actions and discovery for events
// collected from the source list, in a temporary PostgreSQL schema with synthetic pages.
// Must be the first import: the synthetic sessions are dated November 2026.
import './check-event-extraction-clock.mjs';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { PNG } from 'pngjs';
import { EVENT_SOURCES } from '../config/sources.mjs';
import { serviceConfig } from './check-services.mjs';
import { PostgresRepository } from '../lib/server/postgres-repository.mjs';
import { copyEventPhotos } from '../lib/server/event-photos.mjs';
import { canReadMedia } from '../lib/server/access.mjs';
import { qaImage } from '../lib/server/qa-image.mjs';
import { contentHash } from '../lib/server/s3-storage.mjs';
import {
  editEvent,
  listChanges,
  publishCollection,
  revertChange,
  reviewChange,
  startRun,
  storedExtractions,
} from '../lib/server/event-store.mjs';

const { connectionString } = serviceConfig();
const schema = 'events_test_' + Date.now();
const admin = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
const owner = { userId: 'local-owner', role: 'owner' };
const reader = { userId: 'qa-reader', role: 'user' };
const checkedAt = '2026-11-06T18:00:00.000Z';

const definition = {
  id: 'forks',
  name: 'The Forks',
  status: 'active',
  schedule: 'manual',
  fetch: {
    method: 'single-page',
    allowedOrigin: 'https://www.theforks.com',
    startUrls: ['https://www.theforks.com/events'],
    maxListPages: 2,
  },
};
const page1 = 'https://www.theforks.com/events';
const page2 = 'https://www.theforks.com/events/list/2026/12';
const event = (title, sessions, extra = {}) => ({
  url: extra.url || `https://www.theforks.com/events/event/${title.length}`,
  key: extra.key || `url:${title}`,
  title,
  category: 'Experiences',
  description: '',
  venue: 'The Forks Market',
  address: null,
  venueFallback: null,
  price: extra.price == null ? null : { amount: extra.price, currency: 'CAD', text: null },
  availability: null,
  organizerUrl: null,
  ticketUrl: null,
  images: [],
  status: extra.status ?? null,
  reviewReasons: extra.reviewReasons || [],
  sessions: sessions.map((start) => ({
    start: start.slice(0, 10),
    end: start.slice(0, 10),
    startAt: start.length > 10 ? start : null,
    endAt: null,
    status: 'active',
  })),
  runDates: null,
  scheduleError: null,
  evidence: [],
});
const run = (pages, { failedPages = [] } = {}) => ({
  crawl: { failedPages },
  result: {
    source: 'forks',
    checkedAt,
    counts: { failed: pages.filter((p) => p.outcome === 'failed').length, reused: 0 },
    pages: pages.map((p) => ({
      kind: 'listing',
      hash: 'hash-' + p.url,
      raw: { events: [] },
      outcome: p.events?.length ? 'events' : 'none',
      outsideKeys: [],
      events: [],
      ...p,
    })),
  },
});
const publish = async (pages, options) => {
  const { crawl, result } = run(pages, options);
  const runId = await startRun(pool, 'forks');
  return publishCollection(pool, definition, crawl, result, { runId });
};
const changesFor = async (title) =>
  (await listChanges(pool, { open: false })).changes.filter((c) => c.title === title);

try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const dir = new URL('../migrations/postgres/', import.meta.url);
  for (const f of (await readdir(dir)).filter((f) => /^\d+.*\.sql$/.test(f)).sort())
    await pool.query(await readFile(new URL(f, dir), 'utf8'));
  const repo = new PostgresRepository(pool);

  // First run: two pages list the same event (sessions merge) and one other event.
  const concert = event('QA Concert', ['2026-11-20T01:00:00.000Z'], { price: 10 });
  const market = event('QA Market', ['2026-11-21', '2026-11-28']);
  const first = await publish([
    { url: page1, events: [concert, market] },
    {
      url: page2,
      events: [{ ...concert, sessions: [...event('x', ['2026-12-04T01:00:00.000Z']).sessions] }],
    },
  ]);
  assert.deepEqual(first, { new: 2, changed: 0, unchanged: 0, gone: 0, reused: 0 });
  const found = await repo.search({ query: 'QA Concert', principal: owner });
  assert.equal(found.total, 1);
  assert.equal(found.items[0].occurrences.length, 2, 'sessions from both pages merge');
  assert.equal(found.items[0].sourceName, 'The Forks');
  assert.equal(found.items[0].image, '', 'source images are not shown directly');
  assert.equal((await repo.search({ query: 'QA', principal: reader })).total, 2);
  const onDay = await repo.search({ date: '2026-11-28', principal: owner, query: 'QA' });
  assert.deepEqual(
    onDay.items.map((i) => i.title),
    ['QA Market'],
  );
  const concertId = found.items[0].id;
  assert.equal((await repo.detail(concertId, { principal: owner })).title, 'QA Concert');

  // The stored model output is offered again only for an unchanged page.
  const reuse = await storedExtractions(pool, 'forks');
  assert.deepEqual(await reuse(page1, 'hash-' + page1), { events: [] });
  assert.equal(await reuse(page1, 'other-hash'), null);

  // Second run: the concert's price and sessions change; the market is unchanged.
  const second = await publish([
    {
      url: page1,
      events: [
        event('QA Concert', ['2026-11-20T01:00:00.000Z', '2026-11-27T01:00:00.000Z'], {
          price: 12,
        }),
        market,
      ],
    },
    { url: page2, events: [] },
  ]);
  assert.deepEqual(second, { new: 0, changed: 1, unchanged: 1, gone: 0, reused: 0 });
  const [changed] = await changesFor('QA Concert');
  assert.equal(changed.kind, 'changed');
  assert.deepEqual(
    changed.diff.map((d) => d.field),
    ['price', 'sessions'],
  );
  const sessionDiff = changed.diff.find((d) => d.field === 'sessions');
  assert.equal(sessionDiff.added.length, 1);
  assert.equal(sessionDiff.removed.length, 1, 'the December session is no longer listed');

  // Undo restores the previous price as an owner edit and the previous sessions, and later
  // runs leave those sessions alone.
  await revertChange(pool, changed.id, owner.userId, checkedAt);
  let concertNow = await repo.detail(concertId, { principal: owner });
  assert.equal(concertNow.price, 10);
  assert.deepEqual(
    concertNow.occurrences.map((o) => o.startAt),
    ['2026-11-20T01:00:00.000Z', '2026-12-04T01:00:00.000Z'],
  );
  await assert.rejects(revertChange(pool, changed.id, owner.userId), /already undone/);
  const third = await publish([
    {
      url: page1,
      events: [
        event('QA Concert', ['2026-11-20T01:00:00.000Z', '2026-11-27T01:00:00.000Z'], {
          price: 12,
        }),
        market,
      ],
    },
    { url: page2, events: [] },
  ]);
  assert.equal(third.unchanged, 2, 'locked sessions and the same source price are no change');
  concertNow = await repo.detail(concertId, { principal: owner });
  assert.equal(concertNow.occurrences.length, 2);
  assert.equal(concertNow.price, 10, 'the owner edit still wins');

  // Corrections, hiding and review.
  await editEvent(pool, concertId, { fields: { title: 'QA Concert (corrected)', price: null } });
  concertNow = await repo.detail(concertId, { principal: owner });
  assert.equal(concertNow.title, 'QA Concert (corrected)');
  assert.equal(concertNow.price, 12, 'clearing a correction shows the source value again');
  await assert.rejects(editEvent(pool, concertId, { fields: { title: ' ' } }), /title/);
  await assert.rejects(editEvent(pool, concertId, { fields: { evidence: 'x' } }), /cannot/);
  await editEvent(pool, concertId, { hidden: true });
  assert.equal((await repo.search({ query: 'corrected', principal: owner })).total, 0);
  assert.equal((await repo.search({ query: 'corrected', principal: owner, admin: true })).total, 1);
  await editEvent(pool, concertId, { hidden: false });
  const [newMarket] = await changesFor('QA Market');
  await reviewChange(pool, newMarket.id, owner.userId);
  assert.ok((await changesFor('QA Market'))[0].reviewedAt);

  // A failed page protects its events; a page read in full shows the market is gone.
  const failed = await publish([
    { url: page1, outcome: 'failed', reason: 'timeout', events: [], raw: undefined },
    { url: page2, events: [] },
  ]);
  assert.equal(failed.gone, 0);
  const gone = await publish([
    { url: page1, events: [event('QA Concert', ['2026-11-20T01:00:00.000Z'], { price: 12 })] },
    { url: page2, events: [] },
  ]);
  assert.equal(gone.gone, 1);
  assert.equal((await repo.search({ query: 'QA Market', principal: owner })).total, 0);
  const [goneChange] = await changesFor('QA Market');
  assert.equal(goneChange.kind, 'gone');
  await revertChange(pool, goneChange.id, owner.userId, checkedAt);
  assert.equal(
    (await repo.search({ query: 'QA Market', principal: owner })).total,
    1,
    'undoing "gone" keeps the event listed',
  );

  // Undoing a new event hides it.
  await publish([
    {
      url: page1,
      events: [
        event('QA Concert', ['2026-11-20T01:00:00.000Z'], { price: 12 }),
        event('QA Talk', ['2026-11-25']),
      ],
    },
    { url: page2, events: [] },
  ]);
  const [talk] = await changesFor('QA Talk');
  await revertChange(pool, talk.id, owner.userId, checkedAt);
  assert.equal((await repo.search({ query: 'QA Talk', principal: owner })).total, 0);

  const runs = (await pool.query(`SELECT status, counts FROM collection_runs ORDER BY id`)).rows;
  assert.equal(runs.length, 6);
  assert.equal(
    runs[0].status,
    'running',
    'publishCollection leaves finishing the run to the caller',
  );
  const report = (await pool.query(`SELECT report FROM sources WHERE id='forks'`)).rows[0].report;
  assert.equal(report.status, 'ok');

  // Event images are copied once into private media and shown from there (docs/18).
  const png = qaImage([12, 34, 56]);
  const images = {
    'https://www.theforks.com/img/concert.png': png,
    'https://www.theforks.com/img/placeholder.svg': Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    ),
  };
  const photoFetch = async (url) =>
    images[url] ? new Response(images[url]) : new Response('missing', { status: 404 });
  const stored = [];
  const storage = {
    async put(id, bytes, type) {
      assert.equal(id, contentHash(bytes));
      stored.push(id);
      await pool.query(
        `INSERT INTO media(id,object_key,content_type,size,status) VALUES($1,$2,$3,$4,'ready')
         ON CONFLICT DO NOTHING`,
        [id, 'photos/' + id, type, bytes.length],
      );
    },
  };
  const withImage = async (title, url) =>
    pool.query(`UPDATE events SET image_url=$2 WHERE title=$1 RETURNING id`, [title, url]);
  for (const title of ['QA Fair', 'QA Show', 'QA Gala'])
    await pool.query(
      `INSERT INTO events(id,source,source_key,page_url,event_url,title,category,checked_at)
       VALUES($1,'forks',$1,$2,$2,$3,'Experiences',now())`,
      ['photo-' + title, page1, title],
    );
  await withImage('QA Concert', 'https://www.theforks.com/img/concert.png');
  await withImage('QA Fair', 'https://www.theforks.com/img/concert.png');
  await withImage('QA Gala', 'https://www.theforks.com/img/placeholder.svg');
  await withImage('QA Show', 'https://elsewhere.example.test/img.png');
  const photos = await copyEventPhotos(pool, definition, {
    storage,
    fetchImpl: photoFetch,
    pauseMs: 0,
  });
  assert.deepEqual(photos, { copied: 1, reused: 1, notPhoto: 1, failed: 1 });
  assert.deepEqual(stored, [contentHash(png)], 'the shared image is fetched and stored once');
  assert.deepEqual(
    await copyEventPhotos(pool, definition, { storage, fetchImpl: photoFetch, pauseMs: 0 }),
    { copied: 0, reused: 0, notPhoto: 0, failed: 1 },
    'only the off-site image is tried again',
  );
  const shown = (await repo.search({ query: 'QA Concert', principal: reader })).items[0];
  assert.equal(shown.image, '/api/photos/' + contentHash(png));
  assert.deepEqual(shown.images, [shown.image]);
  assert.equal(await canReadMedia(contentHash(png), reader, pool), true);
  assert.equal(await canReadMedia('f'.repeat(64), reader, pool), false);
  await withImage('QA Concert', null);
  await withImage('QA Fair', null);
  await copyEventPhotos(pool, definition, { storage, fetchImpl: photoFetch, pauseMs: 0 });
  assert.equal(
    (await repo.search({ query: 'QA Concert', principal: reader })).items[0].image,
    '',
    'a removed image removes its copy',
  );
  const wag = EVENT_SOURCES.find((s) => s.id === 'wag');
  const wagPage = 'https://www.wag.ca/event/qa-concert/';
  const wagImage = 'https://www.wag.ca/isl/uploads/qa-concert.jpg';
  await startRun(pool, wag.id);
  await pool.query(
    `INSERT INTO events(id,source,source_key,page_url,event_url,title,category,image_url,checked_at)
     VALUES('qa-wag-photo','wag','photo',$1,$1,'QA WAG Concert','Music',$2,now())`,
    [wagPage, wagImage],
  );
  const viewport = new PNG({ width: 8, height: 8 });
  viewport.data.fill(14);
  const picture = new PNG({ width: 4, height: 2 });
  picture.data.fill(255);
  PNG.bitblt(picture, viewport, 0, 0, 4, 2, 2, 3);
  const fetchWag = async (url, init) => {
    if (url === wagImage) return new Response('Forbidden', { status: 403 });
    const request = JSON.parse(init.body);
    assert.equal(request.url, wagImage);
    assert.equal(request.returnScreenshot, true);
    return Response.json({
      status: 'ok',
      solution: {
        status: 200,
        url: wagImage,
        response: `<title>qa-concert.jpg (4×2)</title><meta name="viewport" content="width=device-width, minimum-scale=0.1">
          <body><img src="${wagImage}" style="margin: auto"></body>`,
        screenshot: PNG.sync.write(viewport).toString('base64'),
      },
    });
  };
  assert.deepEqual(await copyEventPhotos(pool, wag, { storage, fetchImpl: fetchWag, pauseMs: 0 }), {
    copied: 1,
    reused: 0,
    notPhoto: 0,
    failed: 0,
  });
  assert.equal(stored.at(-1), contentHash(PNG.sync.write(picture)));
  // A course is bookable as one offering. Starting its first session removes it
  // from discovery while retaining the full schedule and the owner's changes.
  const classRow = (title, days) => ({
    ...event(title, days),
    eventKind: 'class',
    description: 'Learn a new skill.',
    availability: 'available',
    sessions: days.map((day) => ({
      start: day,
      end: day,
      startAt: day + 'T23:00:00.000Z',
      endAt: day + 'T23:30:00.000Z',
      status: 'active',
    })),
    evidence: [{ fields: ['/schedule/dates/0'], sourceUrl: page1, quote: '6:00 to 6:30 p.m.' }],
  });
  const upcomingClass = classRow('QA Upcoming Course', ['2026-11-20', '2026-12-18', '2027-01-08']);
  const startedClass = classRow('QA Started Course', ['2026-11-05', '2026-11-20']);
  await publish([{ url: page1, events: [upcomingClass, startedClass] }]);
  const upcoming = (
    await repo.search({ tab: 'Events', query: upcomingClass.title, principal: reader })
  ).items[0];
  assert.equal(upcoming.eventKind, 'class');
  assert.equal(upcoming.recurring, false);
  assert.equal(upcoming.end, '2027-01-08');
  assert.equal(upcoming.time, '6:00 p.m. – 6:30 p.m.');
  assert.equal(upcoming.occurrences.length, 3);
  assert.equal(
    (await repo.search({ date: '2026-12-18', query: upcomingClass.title, principal: reader }))
      .total,
    0,
  );
  assert.equal((await repo.search({ query: startedClass.title, principal: reader })).total, 0);
  const [startedChange] = await changesFor(startedClass.title);
  const started = await repo.detail(startedChange.eventId, { principal: reader });
  assert.equal(started.classStarted, true);
  assert.equal(started.occurrences.length, 2);
  await editEvent(pool, upcoming.id, { fields: { description: 'Owner wording' } });
  const incomplete = {
    ...upcomingClass,
    description: '',
    availability: null,
    evidence: [],
    sessions: upcomingClass.sessions.map((s) => ({ ...s, endAt: null })),
  };
  await publish([{ url: page1, events: [incomplete, startedClass] }]);
  const kept = await repo.detail(upcoming.id, { principal: reader });
  assert.equal(kept.description, 'Owner wording');
  assert.equal(kept.availability, 'available');
  assert.equal(kept.endAt, upcoming.endAt);
  const changedEnd = {
    ...incomplete,
    sessions: incomplete.sessions.map((s, i) =>
      i === 0 ? { ...s, endAt: '2026-11-21T00:00:00.000Z', end: '2026-11-20' } : s,
    ),
  };
  await publish([{ url: page1, events: [changedEnd, startedClass] }]);
  assert.equal(
    (await repo.detail(upcoming.id, { principal: reader })).endAt,
    '2026-11-21T00:00:00.000Z',
  );
  const conflict = {
    ...changedEnd,
    reviewReasons: [{ field: '/schedule', reason: 'Conflicting end times' }],
    sessions: [],
  };
  await publish([{ url: page1, events: [conflict, startedClass] }]);
  assert.equal(
    (await repo.detail(upcoming.id, { principal: reader })).endAt,
    '2026-11-21T00:00:00.000Z',
  );
  assert.ok(
    (await changesFor(upcomingClass.title)).some((c) =>
      c.diff.some((d) => d.field === 'review_notes'),
    ),
  );

  console.log(
    'Event store: publishes and merges events, reuses unchanged pages, records and undoes changes, keeps owner edits, protects events on failed pages and copies event photos privately.',
  );
} finally {
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
