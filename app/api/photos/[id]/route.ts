import { canReadMedia } from '@/lib/server/access.mjs';
import { photoStorage } from '@/lib/server/services';
import { getPrincipal } from '@/lib/auth';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const principal = await getPrincipal();
  if (!principal) return new Response('Sign in required', { status: 401 });
  const { id } = await params;
  if (!/^[a-f0-9]{64}$/.test(id)) return new Response('Not found', { status: 404 });
  if (principal.role !== 'owner' && !(await canReadMedia(id, principal)))
    return new Response('Not found', { status: 404 });
  try {
    const photo = await photoStorage().get(id);
    if (!photo) return new Response('Photo unavailable', { status: 404 });
    return new Response(new Uint8Array(photo.bytes), {
      headers: {
        'Content-Type': photo.contentType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        ETag: '"' + id + '"',
      },
    });
  } catch {
    return new Response('Photo temporarily unavailable', { status: 503 });
  }
}
