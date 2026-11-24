import { database } from '@/lib/server/postgres.mjs';
import { repository } from '@/lib/server/services';
import { readLimited } from '@/lib/server/request-body.mjs';
import { importItems, savedIds } from '@/lib/server/saved-items.mjs';
import { accountFor, failure, noStore } from './shared';
export const dynamic = 'force-dynamic';

/** The account's saved item IDs, newest first (docs/31). */
export async function GET(request: Request) {
  const { principal, refusal } = await accountFor(request, false);
  if (refusal) return refusal;
  try {
    return Response.json(
      { ids: await savedIds(database(), principal.userId) },
      { headers: noStore },
    );
  } catch (error) {
    return failure(error);
  }
}

/** `{ action: 'import', ids }`: adds a browser's saved list to the account, once, on request. */
export async function POST(request: Request) {
  const { principal, refusal } = await accountFor(request, true);
  if (refusal) return refusal;
  if (!request.headers.get('content-type')?.includes('application/json'))
    return Response.json({ error: 'JSON required' }, { status: 415 });
  let input;
  try {
    const body = await readLimited(request.body, 200000);
    if (!body) return Response.json({ error: 'Request too large' }, { status: 413 });
    input = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (input?.action !== 'import')
    return Response.json({ error: 'Unknown action' }, { status: 400 });
  try {
    const result = await importItems(database(), repository(), principal, input.ids);
    return Response.json(
      { ...result, ids: await savedIds(database(), principal.userId) },
      { headers: noStore },
    );
  } catch (error) {
    return failure(error);
  }
}
