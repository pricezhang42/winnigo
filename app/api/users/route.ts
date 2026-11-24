import { getOwner } from '@/lib/auth';
import { readConfig } from '@/lib/server/config.mjs';
import { rateLimit } from '@/lib/server/access.mjs';
import { database } from '@/lib/server/postgres.mjs';
import { readLimited } from '@/lib/server/request-body.mjs';
import { listUsers, updateUser, UserError } from '@/lib/server/users.mjs';
export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' };

/** Accounts for the owner's Users panel (docs/31). `?q=` filters by name or email. */
export async function GET(request: Request) {
  if (!(await getOwner()))
    return Response.json({ error: 'Owner access required.' }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const offset = Number(params.get('offset') || 0);
  if (!Number.isSafeInteger(offset) || offset < 0)
    return Response.json({ error: 'Invalid offset' }, { status: 400 });
  try {
    return Response.json(
      await listUsers(database(), { query: params.get('q') || '', offset, limit: 50 }),
      { headers: noStore },
    );
  } catch {
    return Response.json({ error: 'Accounts are unavailable.' }, { status: 503 });
  }
}

/** Changes a non-owner account's role or status. Same-origin requests from the owner only. */
export async function POST(request: Request) {
  const owner = await getOwner();
  if (!owner) return Response.json({ error: 'Owner access required.' }, { status: 401 });
  if (request.headers.get('origin') !== readConfig().origin)
    return Response.json({ error: 'Invalid origin' }, { status: 403 });
  if (!(await rateLimit('users:' + owner.userId, 60)))
    return Response.json({ error: 'Try again later' }, { status: 429 });
  if (!request.headers.get('content-type')?.includes('application/json'))
    return Response.json({ error: 'JSON required' }, { status: 415 });
  let input;
  try {
    const body = await readLimited(request.body, 2000);
    if (!body) return Response.json({ error: 'Request too large' }, { status: 413 });
    input = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (input?.action !== 'update' || typeof input.userId !== 'string')
    return Response.json({ error: 'Unknown action' }, { status: 400 });
  try {
    await updateUser(database(), owner.userId, input.userId, {
      role: input.role,
      enabled: input.enabled,
    });
    return Response.json({ ok: true }, { headers: noStore });
  } catch (error) {
    if (error instanceof UserError) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ error: 'Accounts are unavailable.' }, { status: 503 });
  }
}
