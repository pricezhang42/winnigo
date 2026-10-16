import { getPrincipal } from '@/lib/auth';
import { repository } from '@/lib/server/services';
import { validScheduleDay } from '@/lib/event-schedule.mjs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const principal = await getPrincipal();
  if (!principal) return Response.json({ error: 'Sign in required' }, { status: 401 });
  const date = new URL(request.url).searchParams.get('date');
  if (!date || !validScheduleDay(date))
    return Response.json({ error: 'A valid date is required' }, { status: 400 });
  const { id } = await params;
  if (id.length > 300) return new Response('Not found', { status: 404 });
  try {
    const repo = repository();
    const result = repo.availability ? await repo.availability(id, date, { principal }) : null;
    return result
      ? Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
      : new Response('Not found', { status: 404 });
  } catch {
    return Response.json({ error: 'Schedule unavailable' }, { status: 503 });
  }
}
