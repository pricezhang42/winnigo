import { searchCollection } from '@/lib/server/paged-store';
import { parseSearch } from '@/lib/server/search-query.mjs';
import { getReader } from '@/lib/auth';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const principal = await getReader();
  if (!principal) return Response.json({ error: 'Sign in required' }, { status: 401 });
  let query;
  try {
    query = parseSearch(new URL(request.url).searchParams);
  } catch {
    return Response.json({ error: 'Invalid search filters or pagination' }, { status: 400 });
  }
  try {
    return Response.json(await searchCollection(query, false, principal), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json({ error: 'Listing storage unavailable.' }, { status: 503 });
  }
}
