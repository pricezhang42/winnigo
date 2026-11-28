// Private copies of collected event images (docs/18). After a publish, each event's source image
// is fetched once from the source's approved origins, checked to be a real JPEG, PNG, WebP or GIF,
// and stored in private media by its content hash; discovery then shows the copy. Source image
// URLs are never shown directly. Browser-backed assets can fall back to a cropped preview.
import { load } from 'cheerio';
import { PNG } from 'pngjs';
import { contentHash } from './s3-storage.mjs';
import { sourceReader } from './source-reader.mjs';
import { validateSource } from './event-sources.mjs';
import { createFlareSolverrFetch } from './flaresolverr.mjs';

/** The image type of `bytes` from its signature, or null (SVG, HTML and anything else). */
export function photoType(bytes) {
  const b = Buffer.from(bytes);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  if (/^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return 'image/gif';
  return null;
}

/** An image URL the source may be fetched from: https, no credentials, an approved origin. */
export function imageUrl(config, value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw Error('Image URL must be https without credentials');
  if (!config.imageOrigins.has(url.origin)) throw Error('Image host is not approved');
  url.hash = '';
  return url.href;
}

// Chromium centers its standalone image document in the viewport. Require that exact document
// shape and URL so an error page, challenge or website screenshot cannot become an event photo.
function imagePreview({ url, html, screenshot }) {
  const $ = load(html);
  const image = $('body > img');
  const size = $('title')
    .text()
    .match(/\((\d+)×(\d+)\)$/);
  if (
    !size ||
    image.length !== 1 ||
    $('body').children().length !== 1 ||
    image.attr('src') !== url ||
    !image.attr('style')?.includes('margin: auto') ||
    $('head > meta[name="viewport"]').attr('content') !== 'width=device-width, minimum-scale=0.1' ||
    typeof screenshot !== 'string'
  )
    throw Error('Browser did not return a standalone image');

  const bytes = Buffer.from(screenshot, 'base64');
  if (bytes.length < 24 || photoType(bytes) !== 'image/png')
    throw Error('Invalid browser image preview');
  const viewportWidth = bytes.readUInt32BE(16);
  const viewportHeight = bytes.readUInt32BE(20);
  if (!viewportWidth || !viewportHeight || viewportWidth * viewportHeight > 4_000_000)
    throw Error('Oversized browser image preview');

  const width = Number(size[1]);
  const height = Number(size[2]);
  if (!width || !height) throw Error('Invalid browser image dimensions');
  const scale = Math.min(1, viewportWidth / width, viewportHeight / height);
  const cropWidth = Math.max(1, Math.floor(width * scale));
  const cropHeight = Math.max(1, Math.floor(height * scale));
  const viewport = PNG.sync.read(bytes);
  const crop = new PNG({ width: cropWidth, height: cropHeight });
  PNG.bitblt(
    viewport,
    crop,
    Math.round((viewport.width - cropWidth) / 2),
    Math.round((viewport.height - cropHeight) / 2),
    cropWidth,
    cropHeight,
    0,
    0,
  );
  return PNG.sync.write(crop);
}

function photoFetcher(config, fetchImpl = fetch) {
  if (!config.browserImagePattern) return fetchImpl;
  const validateUrl = (value) => {
    const url = new URL(imageUrl(config, value));
    if (url.origin !== config.fetch.allowedOrigin || !config.browserImagePattern.test(url.pathname))
      throw Error('Image path is outside browser source scope');
    return url.href;
  };
  const browser = createFlareSolverrFetch({ fetchImpl, validateUrl, screenshot: true });
  return async (url, init) => {
    const response = await fetchImpl(url, init);
    if (response.status !== 403) return response;
    await response.body?.cancel();
    const preview = imagePreview(await browser(url, init));
    return new Response(preview, { headers: { 'Content-Type': 'image/png' } });
  };
}

/**
 * Copies the images of `definition`'s events that have none yet, or whose image URL changed.
 * An image that is not a photo is remembered and not fetched again until its URL changes; a
 * failed fetch is retried on the next run. Returns counts.
 */
export async function copyEventPhotos(
  pool,
  definition,
  { storage, fetchImpl, pauseMs = 1000, limit = 200, maxRunMs = 600_000 } = {},
) {
  const config = validateSource(definition);
  const counts = { copied: 0, reused: 0, notPhoto: 0, failed: 0 };
  // An event whose image was removed loses its copy.
  await pool.query(
    `UPDATE events SET media_id=NULL, media_source_url=NULL
     WHERE source=$1 AND image_url IS NULL AND media_source_url IS NOT NULL`,
    [config.id],
  );
  const { rows } = await pool.query(
    `SELECT id, image_url FROM events
     WHERE source=$1 AND image_url IS NOT NULL AND status <> 'gone'
       AND media_source_url IS DISTINCT FROM image_url
     ORDER BY first_seen LIMIT $2`,
    [config.id, limit],
  );
  if (!rows.length) return counts;
  const read = sourceReader({
    validateUrl: (value) => imageUrl(config, value),
    fetchImpl: photoFetcher(config, fetchImpl),
    requestTimeoutMs: config.browserImagePattern ? 65_000 : 30_000,
    pauseMs,
    maxRequests: rows.length,
    maxRunMs,
  });
  const save = (eventId, mediaId, url) =>
    pool.query('UPDATE events SET media_id=$2, media_source_url=$3 WHERE id=$1', [
      eventId,
      mediaId,
      url,
    ]);
  for (const { id, image_url: url } of rows) {
    try {
      // The same image (often a venue or artist photo) may already be stored for another event.
      const known = (
        await pool.query(
          'SELECT media_id FROM events WHERE media_source_url=$1 AND media_id IS NOT NULL LIMIT 1',
          [url],
        )
      ).rows[0];
      if (known) {
        await save(id, known.media_id, url);
        counts.reused++;
        continue;
      }
      const bytes = await read(url, 'photo');
      const type = photoType(bytes);
      if (!type) {
        await save(id, null, url);
        counts.notPhoto++;
        continue;
      }
      const mediaId = contentHash(bytes);
      await storage.put(mediaId, bytes, type);
      await save(id, mediaId, url);
      counts.copied++;
    } catch {
      counts.failed++;
    }
  }
  return counts;
}
