import { getAdmin } from '@/lib/auth';
import { readConfig } from '@/lib/server/config.mjs';
import { rateLimit } from '@/lib/server/access.mjs';
import { database } from '@/lib/server/postgres.mjs';
import { readLimited } from '@/lib/server/request-body.mjs';
import {
  editEvent,
  listChanges,
  ReviewError,
  revertChange,
  reviewChange,
} from '@/lib/server/event-store.mjs';
export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' };

/** Published event changes for review (owner or admin). `?all=1` includes reviewed ones. */
export async function GET(request: Request) {
  if (!(await getAdmin()))
    return Response.json({ error: 'Sign in to review events.' }, { status: 401 });
  try {
    const open = new URL(request.url).searchParams.get('all') !== '1';
    return Response.json(
      { ...(await listChanges(database(), { open })), available: true },
      { headers: noStore },
    );
  } catch {
    return Response.json({ error: 'Event changes are unavailable.' }, { status: 503 });
  }
}

/**
 * Review actions: `review` (keep), `revert` (undo) a change, or `edit` an event's fields,
 * hidden flag or session lock. Same-origin requests from a signed-in owner or admin only.
 */
export async function POST(request: Request) {
  const principal = await getAdmin();
  if (!principal) return Response.json({ error: 'Sign in to review events.' }, { status: 401 });
  if (request.headers.get('origin') !== readConfig().origin)
    return Response.json({ error: 'Invalid origin' }, { status: 403 });
  if (!(await rateLimit('event-review:' + principal.userId, 120)))
    return Response.json({ error: 'Try again later' }, { status: 429 });
  if (!request.headers.get('content-type')?.includes('application/json'))
    return Response.json({ error: 'JSON required' }, { status: 415 });
  let input;
  try {
    const body = await readLimited(request.body, 20000);
    if (!body) return Response.json({ error: 'Request too large' }, { status: 413 });
    input = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const pool = database();
  try {
    if (input?.action === 'review' && Number.isSafeInteger(input.changeId))
      await reviewChange(pool, input.changeId, principal.userId);
    else if (input?.action === 'revert' && Number.isSafeInteger(input.changeId))
      await revertChange(pool, input.changeId, principal.userId);
    else if (input?.action === 'edit' && typeof input.eventId === 'string')
      await editEvent(pool, input.eventId, {
        fields: input.fields && typeof input.fields === 'object' ? input.fields : {},
        hidden: input.hidden,
        unlockSessions: input.unlockSessions === true,
      });
    else return Response.json({ error: 'Unknown action' }, { status: 400 });
    return Response.json({ ok: true }, { headers: noStore });
  } catch (error) {
    if (error instanceof ReviewError)
      return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ error: 'Event review is unavailable.' }, { status: 503 });
  }
}
