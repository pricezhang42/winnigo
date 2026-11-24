import { getAdmin } from '@/lib/auth';
import { database } from '@/lib/server/postgres.mjs';
import { recentRuns } from '@/lib/server/collection.mjs';
export const dynamic = 'force-dynamic';

/** Recent collection runs for the admin page (owner or admin). */
export async function GET() {
  if (!(await getAdmin()))
    return Response.json({ error: 'Sign in to manage listings.' }, { status: 401 });
  try {
    return Response.json(
      { runs: await recentRuns(database()), available: true },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return Response.json({ error: 'Run history unavailable.' }, { status: 503 });
  }
}
