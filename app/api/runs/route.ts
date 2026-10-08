import { getAdmin } from '@/lib/auth';
import { readConfig } from '@/lib/server/config.mjs';
import { database } from '@/lib/server/postgres.mjs';
import { recentRuns } from '@/lib/server/collection.mjs';
export const dynamic = 'force-dynamic';

/** Recent collection runs for the admin page (owner or admin). Empty in fixture mode. */
export async function GET() {
  if (!(await getAdmin()))
    return Response.json({ error: 'Sign in to manage listings.' }, { status: 401 });
  if (readConfig().repository !== 'postgres')
    return Response.json(
      { runs: [], available: false },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  try {
    return Response.json(
      { runs: await recentRuns(database()), available: true },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return Response.json({ error: 'Run history unavailable.' }, { status: 503 });
  }
}
