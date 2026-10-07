import { photoStorage } from '@/lib/server/services';
import { readConfig } from '@/lib/server/config.mjs';
import { serviceCredential, rateLimit } from '@/lib/server/access.mjs';
import { getOwner } from '@/lib/auth';
export const dynamic = 'force-dynamic';
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
  let stage = 'read';
  try {
    const uploaded = request.headers.get('content-type') === 'application/octet-stream';
    let url = request.headers.get('x-winnigo-photo-source');
    if (!uploaded) {
      const reader = request.body?.getReader();
      let body = '',
        size = 0;
      const decoder = new TextDecoder();
      if (reader)
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8000) {
            await reader.cancel();
            return Response.json({ error: 'Request too large' }, { status: 413 });
          }
          body += decoder.decode(value, { stream: true });
        }
      body += decoder.decode();
      url = JSON.parse(body).url;
    }
    const source = new URL(url || '');
    if (
      source.protocol !== 'https:' ||
      !source.hostname.endsWith('.fbcdn.net') ||
      source.port ||
      source.username ||
      source.password
    )
      return Response.json({ error: 'Use an original Facebook photo URL' }, { status: 400 });
    stage = 'fetch';
    const response = uploaded
      ? null
      : await fetch(source.href, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    const stream = uploaded ? request.body : response?.body;
    if ((response && !response.ok) || !stream)
      return Response.json({ error: 'Original photo unavailable' }, { status: 422 });
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) {
        await reader.cancel();
        return Response.json({ error: 'Photo exceeds 8 MB' }, { status: 413 });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const mime =
      bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        ? 'image/jpeg'
        : bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71
          ? 'image/png'
          : new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
              new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'
            ? 'image/webp'
            : null;
    if (!mime) return Response.json({ error: 'Unsupported photo format' }, { status: 415 });
    const id = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    stage = 'store';
    if (!(await storage.get(id))) await storage.put(id, bytes, mime);
    return Response.json({ url: '/api/photos/' + id });
  } catch (error) {
    console.error('Photo import failed at stage', stage);
    return Response.json(
      { error: 'Photo could not be saved; retain the original source link.' },
      { status: 502 },
    );
  }
}
