import { database } from '@/lib/server/postgres.mjs';
import { repository } from '@/lib/server/services';
import { saveItem, unsaveItem } from '@/lib/server/saved-items.mjs';
import { accountFor, failure, noStore } from '../shared';
export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string }> };

/** Saves one discovery the account can see. */
export async function PUT(request: Request, { params }: Params) {
  const { principal, refusal } = await accountFor(request, true);
  if (refusal) return refusal;
  try {
    await saveItem(database(), repository(), principal, (await params).id);
    return Response.json({ ok: true }, { headers: noStore });
  } catch (error) {
    return failure(error);
  }
}

/** Removes one saved discovery, listed or not. */
export async function DELETE(request: Request, { params }: Params) {
  const { principal, refusal } = await accountFor(request, true);
  if (refusal) return refusal;
  try {
    await unsaveItem(database(), principal.userId, (await params).id);
    return Response.json({ ok: true }, { headers: noStore });
  } catch (error) {
    return failure(error);
  }
}
