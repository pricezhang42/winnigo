// Worker-only transport. Never forward response cookies or raw proxy errors to logs/API clients.
export function flareSolverrEndpoint(value = process.env.WINNIGO_FLARESOLVERR_URL) {
  if (!value) throw Error('Set WINNIGO_FLARESOLVERR_URL to enable WAG collection');
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

/** Only WAG calendar and individual event URLs are passed to the browser service. */
export function wagUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error('Invalid WAG URL');
  }
  if (
    url.origin !== 'https://www.wag.ca' ||
    url.username ||
    url.password ||
    !(
      /^\/event\/[^/]+\/?$/.test(url.pathname) ||
      /^\/events\/event-calendar\/(?:page\/\d+\/)?$/.test(url.pathname)
    )
  )
    throw Error('Refused non-WAG event/calendar URL');
  return url;
}

async function boundedJson(response, limit) {
  if (!response.body) throw Error('Empty FlareSolverr response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error('FlareSolverr response exceeds size limit');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Error('Invalid FlareSolverr JSON response');
  }
}

export function createWagFetcher({
  endpoint = flareSolverrEndpoint(),
  fetchImpl = fetch,
  timeoutMs = 60000,
  signal,
  maxBytes = 5_000_000,
} = {}) {
  return async (value) => {
    const url = wagUrl(value);
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cmd: 'request.get',
          url: url.href,
          maxTimeout: timeoutMs,
        }),
        signal: AbortSignal.any([
          AbortSignal.timeout(timeoutMs + 5000),
          ...(signal ? [signal] : []),
        ]),
      });
    } catch (error) {
      if (['AbortError', 'TimeoutError'].includes(error.name)) throw error;
      throw new TypeError('FlareSolverr fetch failed', { cause: { code: error.cause?.code } });
    }
    if (!response.ok) throw Error('FlareSolverr returned HTTP ' + response.status);
    const data = await boundedJson(response, maxBytes);
    if (data.status !== 'ok')
      throw Error('FlareSolverr could not retrieve WAG (challenge or timeout)');
    const solution = data.solution;
    if (!solution || solution.status !== 200 || typeof solution.response !== 'string')
      throw Error('FlareSolverr returned an unsuccessful WAG page');
    const finalUrl = wagUrl(solution.url);
    // Calendar pagination may redirect to /page/N/, but an event must remain on that event.
    if (
      url.pathname.startsWith('/event/') &&
      finalUrl.pathname.replace(/\/$/, '') !== url.pathname.replace(/\/$/, '')
    )
      throw Error('WAG event redirected to a different page');
    if (solution.response.length > 2_000_000) throw Error('Unexpected WAG page size');
    if (
      /<title[^>]*>\s*(?:Just a moment|Access denied|Attention Required)/i.test(
        solution.response,
      ) ||
      /<h[12][^>]*>\s*(?:Performing security verification|Verify you are human)/i.test(
        solution.response,
      )
    )
      throw Error('WAG returned a verification page');
    return { url: finalUrl.href, body: solution.response };
  };
}
