import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listingDedupeKey, localDay, parsePlaces } from '../../lib/connectors.mjs';
test('Winnipeg day stays correct around midnight and DST', () => {
  assert.equal(localDay(new Date('2026-09-17T02:00:00Z')), '2026-09-16');
  assert.equal(localDay(new Date('2026-01-01T05:00:00Z')), '2025-12-31');
});
test('identical listings share a duplicate key but different venues do not', () => {
  const a = { title: 'One event', start: '2026-09-19', venue: 'Venue A' };
  assert.equal(listingDedupeKey(a), listingDedupeKey({ ...a, title: 'One Event!' }));
  assert.notEqual(listingDedupeKey(a), listingDedupeKey({ ...a, venue: 'Venue B' }));
});
test('the saved Forks places page parses to valid evergreen places', () => {
  const html = readFileSync(new URL('../fixtures/pages/forks-attractions.html', import.meta.url));
  const places = parsePlaces(String(html), '2026-10-08T12:00:00Z');
  assert.equal(places.length, 26);
  for (const place of places) {
    assert.equal(place.source, 'attractions');
    assert.equal(place.schedule, 'evergreen');
    assert.match(place.url, /^https?:\/\//);
    assert.ok(place.title && !place.start);
  }
});
test('closed places are hidden and unsafe seasonal assumptions excluded', () => {
  const [e] = parsePlaces(
    '<div class="attraction"><img src="/a.jpg"><h3>Historic Rail Bridge</h3><div class="brief"><p>Currently closed for assessment.</p><a href="/bridge">Read more</a></div>',
  );
  assert.equal(e.status, 'hidden');
  assert.equal(e.price, null);
});
test('a changed places layout yields no invented listings', () => {
  assert.deepEqual(parsePlaces('<p>Maintenance</p>'), []);
});
import { normalizeSocial, normalizeHikingBatch } from '../../lib/social.mjs';
const social = {
  title: 'River ride',
  url: 'https://www.facebook.com/groups/810758152436911/posts/123456/?utm_source=test',
  category: 'Cycling',
  type: 'Event',
  start: '2026-09-20',
  distanceKm: '12.5',
  difficulty: 'Moderate',
};
test('social outings retain original attribution and normalize confirmed details', () => {
  const e = normalizeSocial(social);
  assert.equal(e.source, 'facebook');
  assert.equal(e.distanceKm, 12.5);
  assert.equal(e.end, '2026-09-20');
  assert.equal(e.url, 'https://www.facebook.com/groups/810758152436911/posts/123456/');
  assert.equal(e.provenance, 'manual');
});
test('social links reject non-platform URLs, insecure protocols and group homepages', () => {
  for (const url of [
    'https://facebook.com.evil.example/posts/123/',
    'javascript:alert(1)',
    'http://instagram.com/p/abc/',
    'https://www.facebook.com/groups/810758152436911/',
  ])
    assert.throws(() => normalizeSocial({ ...social, url }));
});
test('social listings do not invent dates, price or route difficulty', () => {
  const e = normalizeSocial({
    ...social,
    type: 'Activity',
    url: 'https://www.instagram.com/p/example/',
    distanceKm: '',
    difficulty: 'Unknown',
  });
  assert.equal(e.start, undefined);
  assert.equal(e.price, null);
  assert.equal(e.distanceKm, null);
  assert.equal(e.difficulty, 'Unknown');
});
test('social events reject impossible dates, backwards ranges and invalid distances', () => {
  for (const patch of [
    { start: '2026-02-30' },
    { end: '2026-01-01' },
    { distanceKm: -1 },
    { distanceKm: 'hello' },
  ])
    assert.throws(() => normalizeSocial({ ...social, ...patch }));
});
test('browser batches deduplicate tracked links and never retain personal fields', () => {
  const b = normalizeHikingBatch({
    status: 'ok',
    items: [
      { ...social, author: 'Person', email: 'private@example.com' },
      { ...social, url: social.url.replace('www.', '') },
    ],
  });
  assert.equal(b.items.length, 1);
  assert.equal(b.items[0].sourceVisibility, 'private');
  assert.equal(b.items[0].provenance, 'browser');
  assert.equal(b.items[0].author, undefined);
  assert.equal(b.items[0].email, undefined);
});
test('browser batches reject invalid or misleading checks', () => {
  for (const b of [
    { status: 'blocked', items: [social] },
    { status: 'ok', items: Array(101).fill(social) },
    { status: 'ok', items: [{ ...social, url: 'https://instagram.com/p/abc/' }] },
    { status: 'unknown', items: [] },
  ])
    assert.throws(() => normalizeHikingBatch(b));
  assert.equal(
    normalizeHikingBatch({ status: 'ok', items: [{ ...social, cancelled: true }] }).items[0].status,
    'cancelled',
  );
});

test('discussion notes retain their source and stored photos reject external URLs', () => {
  const url =
    'https://www.facebook.com/groups/810758152436911/posts/123456/?comment_id=789&utm_source=tracking';
  const item = normalizeHikingBatch({
    status: 'ok',
    items: [
      {
        ...social,
        images: ['/api/photos/' + 'a'.repeat(64)],
        commentNotes: [{ text: 'Trailhead signs reported unclear.', url }],
      },
    ],
  }).items[0];
  assert.equal(item.images.length, 1);
  assert.equal(
    item.commentNotes[0].url,
    'https://www.facebook.com/groups/810758152436911/posts/123456/?comment_id=789',
  );
  for (const patch of [
    { images: ['https://example.com/photo.jpg'] },
    { commentNotes: [{ text: 'Test', url: 'https://evil.example/comment/1' }] },
  ])
    assert.throws(() => normalizeHikingBatch({ status: 'ok', items: [{ ...social, ...patch }] }));
});
