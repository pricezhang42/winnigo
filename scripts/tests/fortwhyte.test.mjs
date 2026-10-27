import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  collectFortwhyte,
  parseFortwhyteMonth,
  parseFortwhyteDetailPhotos,
  fortwhyteUrl,
  FORTWHYTE_ID,
} from '../../lib/server/fortwhyte.mjs';
import { normalizeEvents, projectEvent } from '../../lib/event-schedule.mjs';
import { sources } from '../../lib/connectors.mjs';
import { SCHEDULES } from '../../lib/server/job-queue.mjs';
const oct = await readFile('scripts/fixtures/fortwhyte/october.html', 'utf8');
const nov = await readFile('scripts/fixtures/fortwhyte/november.html', 'utf8');
const source = sources.find((s) => s.id === FORTWHYTE_ID),
  now = '2026-10-26T12:00:00Z';
const photo = 'https://www.fortwhyte.org/wp-content/uploads/2026/10/synthetic.png';
const stored = '/api/photos/' + 'b'.repeat(64),
  png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const fetchImpl = async (u, options) => {
  assert.equal(options.redirect, 'error');
  return new Response(u === photo ? png : u.includes('2026-10/') ? oct : nov);
};
const collect = (options = {}) =>
  collectFortwhyte(source, now, { pauseMs: 0, fetchImpl, enrichDetails: false, ...options });
test('FortWhyte shares event details, preserves separate performances and corrects cached DST offsets', async () => {
  const r = await collect();
  assert.equal(r.failedPages.length, 0);
  assert.equal(r.items.length, 2);
  assert.equal(r.occurrencesFound, 5);
  const series = r.items.find((e) => e.recurring);
  assert.equal(series.occurrences.length, 4);
  assert.equal(series.price, null);
  const winter = series.occurrences.find((o) => o.start === '2026-11-01');
  assert.equal(winter.startAt, '2026-11-01T16:30:00.000Z');
  assert.equal(winter.publishedStart, '2026-11-01T10:30:00-06:00');
  const cached = series.occurrences.find((o) => o.start === '2026-11-07');
  assert.equal(cached.startAt, '2026-11-07T16:30:00.000Z');
  assert.equal(cached.publishedStart, '2026-11-07T10:30:00-05:00');
  assert.equal(cached.status, 'cancelled');
  assert.equal(new Set(series.occurrences.map((o) => o.id)).size, 4);
  assert.equal(projectEvent(normalizeEvents(r.items, now)[0]).length, 3);
  const once = r.items.find((e) => !e.recurring);
  assert.equal(once.occurrences[0].endTimeKnown, false);
  assert.match(once.time, /7:00/);
  assert.equal(source.manualOnly, true);
  assert.equal(SCHEDULES[FORTWHYTE_ID], undefined);
  assert.equal(source.collectionTimeoutSeconds, 1800);
});
test('FortWhyte rejects malformed/wrong/overflow-truncated month pages and unsafe URLs', () => {
  for (const html of [
    'Blocked',
    oct.replace('"@graph":', '"@graph":broken'),
    oct.replace('"found_events":2', '"found_events":20'),
    oct.replace('"url_event_date":"2026-10', '"url_event_date":"2026-12'),
    oct.replace('/month/2026-11/', '/month/2026-12/'),
  ])
    assert.throws(() => parseFortwhyteMonth(html, '2026-10'));
  assert.throws(
    () => parseFortwhyteMonth(oct.replace('2026-10-31T10:30:00', '2026-02-30T10:30:00'), '2026-10'),
    /invalid/,
  );
  for (const url of [
    'https://evil.test/event/a/',
    'https://user@www.fortwhyte.org/event/a/',
    'https://www.fortwhyte.org/wp-admin/',
  ])
    assert.throws(() => fortwhyteUrl(url), /Refused/);
  assert.throws(
    () => fortwhyteUrl('https://www.fortwhyte.org/wp-content/uploads/a.svg', 'photo'),
    /Refused/,
  );
});
test('FortWhyte partial month reads keep explicit dates without claiming complete coverage', async () => {
  const r = await collect({
    fetchImpl: async (u) =>
      u.includes('2026-11/') ? new Response('Down', { status: 503 }) : new Response(oct),
  });
  assert.equal(r.failedPages.length, 1);
  assert.equal(r.items.length, 2);
  assert.ok(r.items.every((e) => !e.occurrencesComplete && !e.scheduleCoverage[0].complete));
  const firstMissing = await collect({
    fetchImpl: async (u) =>
      u.includes('2026-10/') ? new Response('Down', { status: 503 }) : new Response(nov),
  });
  assert.equal(firstMissing.pagesRead, 1);
  assert.equal(firstMissing.failedPages.length, 1);
  await assert.rejects(
    collect({ fetchImpl: async () => new Response('Down', { status: 503 }) }),
    /HTTP 503/,
  );
});
test('FortWhyte photo storage reuses private references and retains photos when enrichment fails', async () => {
  let writes = 0;
  const r = await collect({
    storePhoto: async ({ bytes, contentType }) => {
      assert.deepEqual(bytes, png);
      assert.equal(contentType, 'image/png');
      writes++;
      return stored;
    },
  });
  assert.equal(writes, 1);
  const series = r.items.find((e) => e.recurring);
  assert.deepEqual(series.images, [stored]);
  const knownListings = new Map(r.items.map((e) => [e.id, e]));
  const reused = await collect({
    knownListings,
    storePhoto: () => {
      throw Error('Must reuse');
    },
  });
  assert.equal(reused.failedPages.length, 0);
  knownListings.get(series.id).sourceImages = [
    'https://www.fortwhyte.org/wp-content/uploads/old.png',
  ];
  const failed = await collect({
    knownListings,
    storePhoto: () => {
      throw Error('Storage down');
    },
  });
  assert.equal(failed.failedPages.length, 1);
  assert.deepEqual(failed.items.find((e) => e.recurring).images, [stored]);
  assert.equal(failed.occurrencesFound, 5);
});
test('FortWhyte request bounds and explicit empty months fail safely', async () => {
  const limit = await collect({ maxRequests: 1 });
  assert.equal(limit.pagesRead, 1);
  assert.equal(limit.failedPages.length, 1);
  const empty = '<div data-view="month">No events scheduled</div>';
  const r = await collect({ fetchImpl: async () => new Response(empty) });
  assert.equal(r.allowEmpty, true);
  assert.equal(r.items.length, 0);
  const aborted = AbortSignal.abort();
  await assert.rejects(collect({ signal: aborted }), /abort/i);
});

test('FortWhyte caps gallery downloads and rejects oversized or non-image photo responses', async () => {
  const images = Array.from({ length: 4 }, (_, i) => photo.replace('synthetic', `synthetic${i}`));
  const multi = oct.replace(
    '"image":{"contentUrl":"' + photo + '"}',
    '"image":' + JSON.stringify(images),
  );
  let writes = 0;
  const capped = await collect({
    fetchImpl: async (u) =>
      new Response(u.includes('/month/') ? (u.includes('2026-10/') ? multi : nov) : png),
    storePhoto: async () => {
      writes++;
      return stored;
    },
  });
  assert.equal(writes, 3);
  assert.equal(capped.items.find((e) => e.recurring).images.length, 3);
  for (const bad of [Buffer.from('<html>blocked</html>'), Buffer.alloc(8 * 1024 * 1024 + 1)]) {
    const result = await collect({
      fetchImpl: async (u) => new Response(u === photo ? bad : u.includes('2026-10/') ? oct : nov),
      storePhoto: async () => {
        throw Error('Invalid bytes must not reach storage');
      },
    });
    assert.equal(result.failedPages.length, 1);
    assert.equal(result.items.find((e) => e.recurring).images.length, 0);
  }
  const prior = capped.items.find((e) => e.recurring);
  const partial = await collect({
    knownListings: new Map([[prior.id, prior]]),
    fetchImpl: async (u) =>
      u.includes('2026-10/') ? new Response('Down', { status: 503 }) : new Response(nov),
    storePhoto: () => {
      throw Error('No new photo metadata');
    },
  });
  assert.deepEqual(partial.items[0].images, prior.images);
});

const detail = await readFile('scripts/fixtures/fortwhyte/detail.html', 'utf8');
const detailUrl = 'https://www.fortwhyte.org/event/evening-test/';
test('FortWhyte finds description images on matching event pages, excluding site and sponsor images', () => {
  assert.deepEqual(parseFortwhyteDetailPhotos(detail, detailUrl), [photo]);
  assert.throws(
    () => parseFortwhyteDetailPhotos(detail, 'https://www.fortwhyte.org/event/other/'),
    /different event/,
  );
  assert.throws(
    () =>
      parseFortwhyteDetailPhotos(
        detail.replace('class="tribe-events-single-event-description"', 'class="other"'),
        detailUrl,
      ),
    /layout/,
  );
  assert.throws(
    () => parseFortwhyteDetailPhotos(detail.replace(photo, 'https://evil.test/a.png'), detailUrl),
    /Refused/,
  );
});
test('FortWhyte fallback enrichment stores images once and caches event-page checks across refreshes', async () => {
  let details = 0,
    writes = 0;
  const transport = async (u, options) => {
    if (u === detailUrl) {
      details++;
      return new Response(detail);
    }
    return fetchImpl(u, options);
  };
  const options = {
    enrichDetails: true,
    fetchImpl: transport,
    storePhoto: async () => {
      writes++;
      return stored;
    },
  };
  const first = await collect(options);
  assert.equal(first.failedPages.length, 0);
  assert.equal(first.eventPagesRead, 1);
  assert.equal(details, 1);
  assert.equal(writes, 1);
  const once = first.items.find((e) => !e.recurring);
  assert.deepEqual(once.images, [stored]);
  assert.equal(once.photoPage.url, detailUrl);
  const knownListings = new Map(first.items.map((e) => [e.id, e]));
  const repeat = await collect({ ...options, knownListings });
  assert.equal(repeat.failedPages.length, 0);
  assert.equal(details, 1);
  assert.equal(writes, 1);
  const old = knownListings.get(once.id);
  old.photoPage.checkedAt = '2026-10-01T12:00:00Z';
  const failed = await collect({
    ...options,
    knownListings,
    fetchImpl: async (u, o) =>
      u === detailUrl ? new Response('Down', { status: 503 }) : transport(u, o),
  });
  assert.equal(failed.eventPageFailures, 1);
  assert.equal(failed.failedPages.length, 1);
  assert.deepEqual(failed.items.find((e) => e.id === once.id).images, [stored]);
  assert.equal(failed.occurrencesFound, 5);
});
test('FortWhyte featured duplicates retain richer image metadata and reject conflicting dates', () => {
  const doc = JSON.parse(oct.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const duplicate = { ...doc['@graph'][0] };
  delete duplicate.image;
  const json = JSON.stringify({ ...doc, '@graph': [...doc['@graph'], duplicate] });
  const html = oct.replace(
    /(<script type="application\/ld\+json">)[\s\S]*?(<\/script>)/,
    '$1' + json + '$2',
  );
  assert.equal(parseFortwhyteMonth(html, '2026-10').events[0].image.contentUrl, photo);
  assert.throws(
    () =>
      parseFortwhyteMonth(
        html.replace(
          '"endDate":"2026-10-31T11:30:00-05:00"',
          '"endDate":"2026-10-31T12:30:00-05:00"',
        ),
        '2026-10',
      ),
    /disagree/,
  );
});

test('FortWhyte reuses verified image URLs across different shared events before downloading', async () => {
  const initial = await collect({ storePhoto: async () => stored });
  const series = initial.items.find((e) => e.recurring);
  const graph = JSON.parse(
    oct.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1],
  );
  const reordered = oct.replace(
    /(<script type="application\/ld\+json">)[\s\S]*?(<\/script>)/,
    '$1' + JSON.stringify({ '@graph': graph['@graph'].toReversed() }) + '$2',
  );
  const result = await collect({
    enrichDetails: true,
    knownListings: new Map([[series.id, series]]),
    storePhoto: async () => {
      throw Error('Must reuse private media');
    },
    fetchImpl: async (u) => {
      assert.notEqual(
        u,
        photo,
        'An image already saved for another event must not be downloaded again',
      );
      return new Response(u === detailUrl ? detail : u.includes('2026-10/') ? reordered : nov);
    },
  });
  assert.equal(result.failedPages.length, 0);
  assert.deepEqual(result.items.find((e) => !e.recurring).images, [stored]);
});

test('FortWhyte caches a checked event page with no published image without inventing a photo', async () => {
  let reads = 0;
  const empty = detail.replace(/<div class="t-b fw-image">[\s\S]*?<\/div>/, '');
  const options = {
    enrichDetails: true,
    storePhoto: async () => stored,
    fetchImpl: async (u, o) => {
      if (u === detailUrl) {
        reads++;
        return new Response(empty);
      }
      return fetchImpl(u, o);
    },
  };
  const initial = await collect(options),
    once = initial.items.find((e) => !e.recurring);
  assert.equal(initial.failedPages.length, 0);
  assert.deepEqual(once.images, []);
  assert.equal(reads, 1);
  const repeated = await collect({
    ...options,
    knownListings: new Map(initial.items.map((e) => [e.id, e])),
  });
  assert.equal(repeated.failedPages.length, 0);
  assert.deepEqual(repeated.items.find((e) => !e.recurring).images, []);
  assert.equal(reads, 1);
});

test('FortWhyte excludes sponsor logo files even when they use ordinary event image markup', () => {
  const html = detail.replace(
    '</p>',
    '</p><div class="t-b fw-image"><img src="https://www.fortwhyte.org/wp-content/uploads/2020/02/Maxim-Logo_Medium-2.png"></div>',
  );
  assert.deepEqual(parseFortwhyteDetailPhotos(html, detailUrl), [photo]);
});
