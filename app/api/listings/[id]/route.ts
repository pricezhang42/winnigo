import { getReader } from '@/lib/auth';
import { repository } from '@/lib/server/services';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const principal = await getReader();
  if (!principal) return Response.json({ error: 'Sign in required' }, { status: 401 });
  const { id } = await params;
  if (id.length > 300) return new Response('Not found', { status: 404 });
  try {
    const item = await repository().detail(id, { principal });
    return item
      ? Response.json(item, { headers: { 'Cache-Control': 'no-store' } })
      : new Response('Not found', { status: 404 });
  } catch {
    return new Response('Listing storage unavailable', { status: 503 });
  }
}
