import { photoStorage } from '@/lib/server/services';
import { readConfig } from '@/lib/server/config.mjs';
import { serviceCredential, rateLimit } from '@/lib/server/access.mjs';
import { readLimited } from '@/lib/server/request-body.mjs';
import { getOwner } from '@/lib/auth';
export const dynamic = 'force-dynamic';

const MAX_METADATA_BYTES = 8000;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/** Recognises JPEG, PNG and WebP from their file signatures; anything else is rejected. */
function imageType(bytes: Uint8Array) {
  const ascii = (start: number, end: number) => new TextDecoder().decode(bytes.slice(start, end));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return 'image/png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Only original photos from Facebook's CDN may be imported. */
function isFacebookPhotoUrl(url: URL) {
  return (
    url.protocol === 'https:' &&
    url.hostname.endsWith('.fbcdn.net') &&
    !url.port &&
    !url.username &&
    !url.password
  );
}

/**
 * Stores a Facebook post photo and returns its stable `/api/photos/<sha256>` URL.
 *
 * Two request forms are accepted:
 * - JSON `{ url }`: the server downloads the photo from that URL.
 * - `application/octet-stream`: the caller uploads the bytes, naming the original URL in the
 *   `x-winnigo-photo-source` header. The collector uses this because it fetches photos with
 *   its signed-in browser.
 *
 * The photo ID is the content hash, so re-importing the same photo is a no-op.
 */
export async function POST(request: Request) {
  const storage = photoStorage();
  const collector =
    readConfig().repository === 'postgres' ? await serviceCredential(request.headers) : null;
  const owner = collector ? null : await getOwner();
  if (!collector && !owner) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!collector && request.headers.get('origin') !== readConfig().origin)
    return Response.json({ error: 'Invalid origin' }, { status: 403 });
  if (collector && collector.source_id !== 'facebook')
    return Response.json({ error: 'Wrong source scope' }, { status: 403 });
  if (
    readConfig().repository === 'postgres' &&
    !(await rateLimit('photo-import:' + (collector?.id || owner!.userId), 120))
  )
    return Response.json({ error: 'Try again later' }, { status: 429 });

  // Only the failing stage is logged, never the error details or source URL.
  let stage = 'read';
  try {
    const uploaded = request.headers.get('content-type') === 'application/octet-stream';
    let url = request.headers.get('x-winnigo-photo-source');
    if (!uploaded) {
      const body = await readLimited(request.body, MAX_METADATA_BYTES);
      if (!body) return Response.json({ error: 'Request too large' }, { status: 413 });
      url = JSON.parse(new TextDecoder().decode(body)).url;
    }
    const source = new URL(url || '');
    if (!isFacebookPhotoUrl(source))
      return Response.json({ error: 'Use an original Facebook photo URL' }, { status: 400 });

    stage = 'fetch';
    const response = uploaded
      ? null
      : await fetch(source.href, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    const stream = uploaded ? request.body : response?.body;
    if ((response && !response.ok) || !stream)
      return Response.json({ error: 'Original photo unavailable' }, { status: 422 });
    const bytes = await readLimited(stream, MAX_PHOTO_BYTES);
    if (!bytes) return Response.json({ error: 'Photo exceeds 8 MB' }, { status: 413 });

    const mime = imageType(bytes);
    if (!mime) return Response.json({ error: 'Unsupported photo format' }, { status: 415 });
    const id = await sha256Hex(bytes);
    stage = 'store';
    if (!(await storage.get(id))) await storage.put(id, bytes, mime);
    return Response.json({ url: '/api/photos/' + id });
  } catch {
    console.error('Photo import failed at stage', stage);
    return Response.json(
      { error: 'Photo could not be saved; retain the original source link.' },
      { status: 502 },
    );
  }
}
