// Shared bounded HTTP and private-media handling for public event calendar adapters.
import { load } from 'cheerio';
import { setTimeout as pause } from 'node:timers/promises';
import { readLimited } from './request-body.mjs';
export const cleanEventText = (value) =>
  load(load(String(value || '')).text())
    .text()
    .replace(/\s+/g, ' ')
    .trim();
const PRIVATE = /^\/api\/photos\/[a-f0-9]{64}$/;
const lastByOrigin = new Map();
export function sourceReader({
  validateUrl,
  fetchImpl = fetch,
  pauseMs = 1000,
  maxRequests = 600,
  maxRunMs = 540000,
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
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      headers: { 'User-Agent': 'Winnigo/1.0 (public event collection)', ...init.headers },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error('Source returned HTTP ' + response.status);
    }
    const bytes = await readLimited(response.body, kind === 'photo' ? 8 * 1024 * 1024 : 2_000_000);
    if (!bytes?.length) throw Error('Empty or oversized event source response');
    return Buffer.from(bytes);
  };
}
export function storedPhotoCache(knownListings, validateUrl) {
  const cache = new Map();
  for (const item of knownListings.values())
    for (let i = 0; i < (item.sourceImages || []).length; i++) {
      if (!PRIVATE.test(item.images?.[i] || '')) continue;
      try {
        cache.set(validateUrl(item.sourceImages[i], 'photo'), item.images[i]);
      } catch {
        /* Ignore unverified historical media. */
      }
    }
  return cache;
}
export function retainEventPhotos(item, old) {
  const pairs = (old?.images || [])
    .map((image, i) => [image, old.sourceImages?.[i]])
    .filter(([image]) => PRIVATE.test(image))
    .slice(0, 3);
  item.images = pairs.map(([i]) => i);
  item.sourceImages = pairs.map(([, u]) => u);
  item.image = item.images[0] || '';
}
export async function collectEventPhotos(item, urls, { read, storePhoto, cache }) {
  item.sourceImages = [...new Set(urls)].slice(0, 3);
  item.images = [];
  item.image = '';
  if (!storePhoto) return;
  for (const url of item.sourceImages) {
    let stored = cache.get(url);
    if (!stored) {
      const bytes = await read(url, 'photo');
      const contentType =
        bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          ? 'image/jpeg'
          : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            ? 'image/png'
            : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
              ? 'image/webp'
              : null;
      if (!contentType) throw Error('Event photo is not a supported image');
      stored = await storePhoto({ bytes, contentType });
      if (!PRIVATE.test(stored)) throw Error('Invalid private event photo reference');
      cache.set(url, stored);
    }
    item.images.push(stored);
  }
  item.image = item.images[0] || '';
}
