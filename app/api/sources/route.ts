import { getAdmin } from '@/lib/auth';
import { searchCollection } from '@/lib/server/paged-store';
import { parseSearch } from '@/lib/server/search-query.mjs';
import { repository } from '@/lib/server/services';
import { readConfig } from '@/lib/server/config.mjs';
import { serviceCredential, rateLimit } from '@/lib/server/access.mjs';
import { applyAction, ActionError } from '@/lib/server/actions.mjs';
import { readLimited } from '@/lib/server/request-body.mjs';
export const dynamic = 'force-dynamic';

const MAX_BATCH_BYTES = 250000;

/** Admin listing search: includes hidden items and source errors. */
export async function GET(request: Request) {
  const principal = await getAdmin();
  if (!principal) return Response.json({ error: 'Sign in to manage listings.' }, { status: 401 });
  let query;
  try {
    query = parseSearch(new URL(request.url).searchParams);
  } catch {
    return Response.json({ error: 'Invalid query' }, { status: 400 });
  }
  try {
    return Response.json(await searchCollection(query, true, principal), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json({ error: 'Listing storage is temporarily unavailable.' }, { status: 503 });
  }
}
/**
 * Collection changes. Callers are either a collector (service token, `sync-hiking-manitoba`
 * only, Facebook scope) or a signed-in admin (`update`) / owner (any action). Cookie-authenticated
 * requests must come from the configured origin.
 */
export async function POST(request: Request) {
  const collector =
    readConfig().repository === 'postgres' ? await serviceCredential(request.headers) : null;
  const principal = collector ? null : await getAdmin();
  if (!collector && !principal)
    return Response.json({ error: 'Sign in to manage listings.' }, { status: 401 });
  if (!collector && request.headers.get('origin') !== readConfig().origin)
    return Response.json({ error: 'Invalid origin' }, { status: 403 });
  if (
    readConfig().repository === 'postgres' &&
    !(await rateLimit('import:' + (collector?.id || principal!.userId), 60))
  )
    return Response.json({ error: 'Try again later' }, { status: 429 });
  if (!request.headers.get('content-type')?.includes('application/json'))
    return Response.json({ error: 'JSON required' }, { status: 415 });
  try {
    const body = await readLimited(request.body, MAX_BATCH_BYTES);
    if (!body) return Response.json({ error: 'Batch too large' }, { status: 413 });
    let input;
    try {
      input = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return Response.json({ error: 'Invalid action' }, { status: 400 });
    if (collector && input.action !== 'sync-hiking-manitoba')
      return Response.json({ error: 'Collector action only' }, { status: 403 });
    if (collector && collector.source_id !== 'facebook')
      return Response.json({ error: 'Wrong source scope' }, { status: 403 });
    if (!collector && principal?.role !== 'owner' && input.action !== 'update')
      return Response.json({ error: 'Owner access required' }, { status: 403 });
    const result = await applyAction(input, repository(), principal || undefined);
    return Response.json(result ?? { ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json(
      { error: error instanceof ActionError ? error.message : 'Changes could not be saved.' },
      { status: error instanceof ActionError ? error.status : 503 },
    );
  }
}
