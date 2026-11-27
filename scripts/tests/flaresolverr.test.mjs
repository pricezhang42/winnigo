import assert from 'node:assert/strict';
import test from 'node:test';
import { createFlareSolverrFetch, flareSolverrEndpoint } from '../../lib/server/flaresolverr.mjs';

const endpoint = 'http://127.0.0.1:8191/v1';
const target = 'https://events.example.test/events';
const validateUrl = (value) => {
  const url = new URL(value);
  if (url.origin !== 'https://events.example.test') throw Error('Refused URL outside source scope');
  return url.href;
};
const success = (html = '<main>Events</main>', url = target) => ({
  status: 'ok',
  solution: {
    status: 200,
    url,
    response: html,
    cookies: [{ name: 'clearance', value: 'SECRET' }],
  },
});

function stubFetcher(data, options = {}) {
  const requests = [];
  const fetcher = createFlareSolverrFetch({
    endpoint,
    validateUrl,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return Response.json(data);
    },
    ...options,
  });
  return { fetcher, requests };
}

test('FlareSolverr endpoints are bare HTTP(S) origins without credentials', () => {
  assert.equal(flareSolverrEndpoint('http://127.0.0.1:8191'), endpoint);
  assert.throws(() => flareSolverrEndpoint('http://user:secret@localhost:8191'), /credentials/);
  assert.throws(() => flareSolverrEndpoint('http://localhost:8191/v1'), /path/);
  assert.throws(() => flareSolverrEndpoint('not a URL'), /Invalid/);
});

test('FlareSolverr returns only validated rendered HTML and the final source URL', async () => {
  const finalUrl = target + '/';
  const { fetcher, requests } = stubFetcher(success('<main>Rendered</main>', finalUrl));
  const response = await fetcher(target);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, endpoint);
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    cmd: 'request.get',
    url: target,
    maxTimeout: 60000,
  });
  assert.equal(response.url, finalUrl);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(await response.text(), '<main>Rendered</main>');
});

test('FlareSolverr rejects challenges, out-of-scope redirects and oversized responses', async () => {
  await assert.rejects(
    stubFetcher(success('<title>Just a moment...</title>')).fetcher(target),
    /verification page/,
  );
  await assert.rejects(
    stubFetcher(success('<main>Bad</main>', 'https://elsewhere.example.test/')).fetcher(target),
    /outside source scope/,
  );
  await assert.rejects(stubFetcher(success(), { maxBytes: 20 }).fetcher(target), /oversized/);
  const missingUrl = success();
  delete missingUrl.solution.url;
  await assert.rejects(stubFetcher(missingUrl).fetcher(target), /invalid source response/);
  await assert.rejects(stubFetcher(success({ toString: () => 'not html' })).fetcher(target));
});

test('FlareSolverr errors do not expose service messages or cookies', async () => {
  await assert.rejects(
    stubFetcher({ status: 'error', message: 'SECRET upstream detail' }).fetcher(target),
    (error) => {
      assert.equal(
        error.message,
        'FlareSolverr could not retrieve the source page (challenge or timeout)',
      );
      assert.doesNotMatch(error.message, /SECRET/);
      return true;
    },
  );
  const fetcher = createFlareSolverrFetch({
    endpoint,
    validateUrl,
    fetchImpl: async () => {
      throw Error('SECRET upstream detail');
    },
  });
  await assert.rejects(fetcher(target), (error) => {
    assert.equal(error.message, 'FlareSolverr fetch failed');
    assert.doesNotMatch(error.message, /SECRET/);
    return true;
  });
});
