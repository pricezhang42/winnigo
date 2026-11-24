import test from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicates, samePlace } from '../../lib/server/event-duplicates.mjs';

const T = '2026-12-05T01:00Z';
const event = (id, source, extra = {}) => ({
  id,
  source,
  title: 'Jann Arden and Her Holiday Orchestra',
  venue: 'Centennial Concert Hall',
  starts: [T],
  days: ['2026-12-04'],
  ...extra,
});

test('the same title, time and place from two sources is shown once, under the organizer', () => {
  const { duplicates, candidates } = findDuplicates([
    event('tw', 'tourism-winnipeg', { title: 'Jann Arden & Her Holiday Orchestra™' }),
    event('mm', 'manitoba-music'),
    event('org', 'wso'),
  ]);
  assert.deepEqual(Object.fromEntries(duplicates), { tw: 'org', mm: 'org' });
  assert.deepEqual(candidates, []);
});

test('a title and day alone, or an unknown time, is only a candidate', () => {
  const differentTime = findDuplicates([
    event('a', 'tourism-winnipeg'),
    event('b', 'manitoba-music', { starts: ['2026-12-05T03:30Z'] }),
  ]);
  assert.equal(differentTime.duplicates.size, 0);
  assert.deepEqual(differentTime.candidates, [['a', 'b']]);
  const unknown = findDuplicates([
    event('a', 'tourism-winnipeg', { starts: [null] }),
    event('b', 'manitoba-music', { starts: [null] }),
  ]);
  assert.equal(unknown.duplicates.size, 0);
  assert.deepEqual(unknown.candidates, [['a', 'b']]);
});

test('a different place needs a shared link to match', () => {
  const elsewhere = [
    event('a', 'fortwhyte', { venue: 'Buffalo Crossing', address: '' }),
    event('b', 'tourism-winnipeg', { venue: 'Pavilion', address: '' }),
  ];
  assert.equal(findDuplicates(elsewhere).duplicates.size, 0);
  elsewhere[0].eventUrl = elsewhere[1].ticketUrl = 'https://example.test/show';
  assert.deepEqual(Object.fromEntries(findDuplicates(elsewhere).duplicates), { b: 'a' });
});

test('every session of the shorter run must appear in the longer one', () => {
  const later = '2026-12-06T01:00Z';
  const subset = findDuplicates([
    event('a', 'tourism-winnipeg', { starts: [T] }),
    event('b', 'manitoba-museum', { starts: [T, later] }),
  ]);
  assert.deepEqual(Object.fromEntries(subset.duplicates), { a: 'b' });
  const partial = findDuplicates([
    event('a', 'tourism-winnipeg', { starts: [T, '2026-12-07T01:00Z'] }),
    event('b', 'manitoba-museum', { starts: [T, later] }),
  ]);
  assert.equal(partial.duplicates.size, 0);
});

test('an owner-edited event is the one shown', () => {
  const { duplicates } = findDuplicates([
    event('tw', 'tourism-winnipeg', { ownerEdited: true }),
    event('org', 'wso'),
  ]);
  assert.deepEqual(Object.fromEntries(duplicates), { org: 'tw' });
});

test('two events from one source are never merged through a third', () => {
  const { duplicates, candidates } = findDuplicates([
    event('a1', 'manitoba-music'),
    event('a2', 'manitoba-music'),
    event('b', 'tourism-winnipeg'),
  ]);
  assert.equal(duplicates.size, 0);
  assert.equal(candidates.length, 2);
});

test('places match on their distinctive words', () => {
  assert.ok(samePlace({ venue: 'Burton Cummings Theatre' }, { venue: 'Burton Cumming Theatre' }));
  assert.ok(
    samePlace(
      { venue: 'FortWhyte Alive', address: '1961 McCreary Rd' },
      { venue: 'Richardson Interpretive Centre', address: '1961 McCreary Road, Winnipeg' },
    ),
  );
  assert.ok(!samePlace({ venue: 'Buffalo Crossing' }, { venue: 'FortWhyte Alive' }));
  assert.ok(!samePlace({ venue: '' }, { venue: 'Centennial Concert Hall' }));
});
