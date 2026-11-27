// Bounded, polite reads for event sources: one request per second per origin, request and time
// budgets per run, and a size cap on every response. Ordinary HTTP redirects stay with the caller;
// browser transports validate their final URL. `withUrl` retains that rendered page's final URL.
import { setTimeout as pause } from 'node:timers/promises';
import { readLimited } from './request-body.mjs';

const lastByOrigin = new Map();
export function sourceReader({
  validateUrl,
  fetchImpl = fetch,
  pauseMs = 1000,
  maxRequests = 600,
  maxRunMs = 540000,
  requestTimeoutMs = 30000,
  withUrl = false,
  signal = AbortSignal.timeout(maxRunMs),
}) {
  let requests = 0;
  return async (value, kind = 'page', init = {}) => {
    const url = validateUrl(value, kind),
      origin = new URL(url).origin;
    signal.throwIfAborted();
    if (requests >= maxRequests) throw Error('Collection request limit reached');
    await pause(Math.max(0, (lastByOrigin.get(origin) || 0) + pauseMs - Date.now()), undefined, {
      signal,
    });
    signal.throwIfAborted();
    lastByOrigin.set(origin, Date.now());
    requests++;
    const response = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
      headers: { 'User-Agent': 'Winnigo/1.0 (public event collection)', ...init.headers },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error('Source returned HTTP ' + response.status);
    }
    const bytes = await readLimited(response.body, kind === 'photo' ? 8 * 1024 * 1024 : 2_000_000);
    if (!bytes?.length) throw Error('Empty or oversized event source response');
    const body = Buffer.from(bytes);
    return withUrl ? { body, url: response.url || url } : body;
  };
}
