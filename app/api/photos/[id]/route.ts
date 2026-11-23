import { canReadMedia } from '@/lib/server/access.mjs';
import { photoStorage } from '@/lib/server/services';
import { getPrincipal } from '@/lib/auth';
export const dynamic = 'force-dynamic';
// A media ID is the photo's content hash, so its bytes never change: the viewer's browser may keep
// it for a day. Access is still checked on every request, and a revalidation is answered without
// reading storage.
const CACHE = 'private, max-age=86400';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const principal = await getPrincipal();
  if (!principal) return new Response('Sign in required', { status: 401 });
  const { id } = await params;
  if (!/^[a-f0-9]{64}$/.test(id)) return new Response('Not found', { status: 404 });
  if (principal.role !== 'owner' && !(await canReadMedia(id, principal)))
    return new Response('Not found', { status: 404 });
  if (request.headers.get('if-none-match') === '"' + id + '"')
    return new Response(null, {
      status: 304,
      headers: { 'Cache-Control': CACHE, ETag: '"' + id + '"' },
    });
  try {
    const photo = await photoStorage().get(id);
    if (!photo) return new Response('Photo unavailable', { status: 404 });
    return new Response(new Uint8Array(photo.bytes), {
      headers: {
        'Content-Type': photo.contentType,
        'Cache-Control': CACHE,
        'X-Content-Type-Options': 'nosniff',
        ETag: '"' + id + '"',
      },
    });
  } catch {
    return new Response('Photo temporarily unavailable', { status: 503 });
  }
}
