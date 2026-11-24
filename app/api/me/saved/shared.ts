import 'server-only';
import { getPrincipal } from '@/lib/auth';
import { readConfig } from '@/lib/server/config.mjs';
import { rateLimit } from '@/lib/server/access.mjs';
import { hasAccount, SavedError } from '@/lib/server/saved-items.mjs';

export const noStore = { 'Cache-Control': 'no-store' };

/** The signed-in account for a saved-items request, or the response refusing it. */
export async function accountFor(request: Request, write: boolean) {
  const principal = await getPrincipal();
  if (!principal || !hasAccount(principal))
    return {
      refusal: Response.json(
        { error: principal ? 'This mode keeps saved items in the browser.' : 'Sign in to save.' },
        { status: principal ? 409 : 401, headers: noStore },
      ),
    };
  if (write && request.headers.get('origin') !== readConfig().origin)
    return { refusal: Response.json({ error: 'Invalid origin' }, { status: 403 }) };
  if (write && !(await rateLimit('saved:' + principal.userId, 120)))
    return { refusal: Response.json({ error: 'Try again later' }, { status: 429 }) };
  return { principal: principal as { userId: string; role: string } };
}

/** A safe response for a failed saved-items request. */
export function failure(error: unknown) {
  if (error instanceof SavedError)
    return Response.json({ error: error.message }, { status: error.status, headers: noStore });
  return Response.json({ error: 'Saved items are unavailable.' }, { status: 503 });
}
