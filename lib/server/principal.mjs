import { readConfig } from './config.mjs';
import { isOwner } from '../auth-policy.mjs';
import { accounts } from './accounts.mjs';
import { database } from './postgres.mjs';
/** A visitor without an account: public discoveries only, and no saving or administration. */
export const VISITOR = Object.freeze({ role: 'visitor', legacy: false });

/**
 * Who may read discoveries: the signed-in principal, a visitor when public browsing is enabled
 * (docs/31), or null.
 */
export async function readerFromHeaders(headers) {
  return (await principalFromHeaders(headers)) ?? (readConfig().publicBrowsing ? VISITOR : null);
}

/**
 * Works out who is making a request: `{ userId, role, name?, email?, legacy }`, or null.
 *
 * In `local`/`basic` mode the owner check in auth-policy.mjs yields a fixed owner principal.
 * Otherwise the Better Auth session cookie must belong to a verified, enabled account; the role
 * is read from `user_access` on every request, so role changes and disabling apply immediately.
 * Collector tokens are not principals; import routes check them with `serviceCredential`.
 */
export async function principalFromHeaders(headers) {
  const config = readConfig();
  if (['local', 'basic'].includes(config.mode) && isOwner(headers, config.auth))
    return { userId: 'local-owner', role: 'owner', legacy: true };
  if (!process.env.BETTER_AUTH_SECRET) return null;
  const session = await accounts().api.getSession({ headers });
  if (!session?.user.emailVerified) return null;
  const access = (
    await database().query('SELECT role,enabled FROM user_access WHERE user_id=$1', [
      session.user.id,
    ])
  ).rows[0];
  if (!access?.enabled) return null;
  return {
    userId: session.user.id,
    role: access.role,
    name: session.user.name,
    email: session.user.email,
    legacy: false,
  };
}
