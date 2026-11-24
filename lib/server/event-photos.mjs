// Private copies of collected event images (docs/18). After a publish, each event's source image
// is fetched once from the source's approved origins, checked to be a real JPEG, PNG, WebP or GIF,
// and stored in private media by its content hash; discovery then shows the copy. Source image
// URLs are never shown directly.
import { contentHash } from './s3-storage.mjs';
import { sourceReader } from './source-reader.mjs';
import { validateSource } from './event-sources.mjs';

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
    ...(fetchImpl ? { fetchImpl } : {}),
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
