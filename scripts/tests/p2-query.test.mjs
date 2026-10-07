import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSearch } from '../../lib/server/search-query.mjs';
import { canonical } from '../../lib/server/postgres-repository.mjs';
test('P2 search rejects unbounded requests and unknown filters', () => {
  for (const query of [
    'limit=101',
    'offset=-1',
    'limit=abc',
    'unexpected=x',
    'ids=' + Array(201).fill('x').join(','),
  ])
    assert.throws(() => parseSearch(new URLSearchParams(query)));
  assert.equal(parseSearch(new URLSearchParams()).limit, 24);
  assert.equal(parseSearch(new URLSearchParams('query=%25%27')).query, "%'");
});
test('P2 canonical social identity removes tracking but preserves post identity', () => {
  assert.equal(
    canonical('https://www.facebook.com/story.php?utm_source=test&story_fbid=123&id=45#x'),
    'https://facebook.com/story.php?id=45&story_fbid=123',
  );
  assert.notEqual(
    canonical('https://facebook.com/story.php?id=45&story_fbid=123'),
    canonical('https://facebook.com/story.php?id=45&story_fbid=124'),
  );
});
