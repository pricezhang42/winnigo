import { readConfig } from './config.mjs';
import { isOwner } from '../auth-policy.mjs';
import { accounts } from './accounts.mjs';
import { database } from './postgres.mjs';
export async function principalFromHeaders(headers) {
  const config = readConfig();
  if (['local', 'basic'].includes(config.mode) && isOwner(headers, config.auth))
    return { userId: 'local-owner', role: 'owner', legacy: true };
  if (config.repository !== 'postgres' || !process.env.BETTER_AUTH_SECRET) return null;
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
