import { readLimited } from './request-body.mjs';

/** A configured FlareSolverr HTTP endpoint, defaulting to its local Compose service. */
export function flareSolverrEndpoint(
  value = process.env.WINNIGO_FLARESOLVERR_URL || 'http://127.0.0.1:8191',
) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error('Invalid WINNIGO_FLARESOLVERR_URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw Error('WINNIGO_FLARESOLVERR_URL must be an HTTP(S) origin without credentials or path');
  return new URL('/v1', url).href;
}

async function boundedJson(response, limit) {
  const bytes = await readLimited(response.body, limit);
  if (!bytes?.length) throw Error('Empty or oversized FlareSolverr response');
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw Error('Invalid FlareSolverr JSON response');
  }
}

/**
 * Fetch-compatible browser transport for sourceReader. Target and final URLs are checked by the
 * source's own scope validator. Browser cookies and upstream response details stay in the service.
 */
export function createFlareSolverrFetch({
  endpoint = flareSolverrEndpoint(),
  fetchImpl = fetch,
  validateUrl,
  timeoutMs = 60000,
  maxBytes = 5_000_000,
} = {}) {
  if (typeof validateUrl !== 'function') throw Error('FlareSolverr needs a source URL validator');
  return async (value, init = {}) => {
    const url = validateUrl(value);
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: timeoutMs }),
        signal: init.signal || AbortSignal.timeout(timeoutMs + 5000),
      });
    } catch (error) {
      if (['AbortError', 'TimeoutError'].includes(error.name)) throw error;
      throw new TypeError('FlareSolverr fetch failed', { cause: { code: error.cause?.code } });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Error('FlareSolverr returned HTTP ' + response.status);
    }
    const data = await boundedJson(response, maxBytes);
    if (data.status !== 'ok')
      throw Error('FlareSolverr could not retrieve the source page (challenge or timeout)');
    const solution = data.solution;
    if (
      !solution ||
      !Number.isInteger(solution.status) ||
      solution.status < 100 ||
      solution.status > 599 ||
      typeof solution.url !== 'string' ||
      typeof solution.response !== 'string'
    )
      throw Error('FlareSolverr returned an invalid source response');
    const finalUrl = validateUrl(solution.url);
    if (
      /<title[^>]*>\s*(?:Just a moment|Access denied|Attention Required)/i.test(
        solution.response,
      ) ||
      /<h[12][^>]*>\s*(?:Performing security verification|Verify you are human)/i.test(
        solution.response,
      )
    )
      throw Error('Source returned a verification page');
    if (solution.status !== 200) throw Error('Source returned HTTP ' + solution.status);
    const page = new Response(solution.response, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
    Object.defineProperty(page, 'url', { value: finalUrl });
    return page;
  };
}
