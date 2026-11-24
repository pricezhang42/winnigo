// Account management for the owner's Users panel (docs/31) and the cleanup command. The owner's
// own role and status change only through the operator commands (bootstrap-owner,
// transfer-owner), never here.
import { writeTransaction } from './postgres.mjs';

export class UserError extends Error {}

/**
 * Accounts, newest first, optionally filtered by name or email: role, status, verification,
 * sign-in methods and the last sign-in (from the 90-day security audit).
 * @param {import('pg').Pool} pool
 * @param {{ query?: string, limit?: number, offset?: number }} [options]
 */
export async function listUsers(pool, { query = '', limit = 50, offset = 0 } = {}) {
  const search = query.trim().toLowerCase().slice(0, 100);
  const params = [Math.min(200, Math.max(1, limit)), Math.max(0, offset)];
  const where = search
    ? `WHERE strpos(lower(u.email), $3) > 0 OR strpos(lower(u.name), $3) > 0`
    : '';
  if (search) params.push(search);
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u."emailVerified" AS verified, u."createdAt" AS "createdAt",
       coalesce(a.role, 'user') AS role, coalesce(a.enabled, false) AS enabled,
       (SELECT coalesce(jsonb_agg(DISTINCT p."providerId"), '[]') FROM auth_account p
         WHERE p."userId" = u.id) AS methods,
       (SELECT max(s.created_at) FROM security_audit s
         WHERE s.user_id = u.id AND s.action = 'session.created') AS "lastSignIn",
       count(*) OVER ()::int AS total
     FROM auth_user u LEFT JOIN user_access a ON a.user_id = u.id
     ${where}
     ORDER BY u."createdAt" DESC, u.id
     LIMIT $1 OFFSET $2`,
    params,
  );
  return {
    users: rows.map(({ total, ...user }) => user),
    total: rows[0]?.total ?? 0,
  };
}

/**
 * Changes a non-owner account: `role` (admin or user; verified accounts only) and/or `enabled`.
 * Disabling revokes the account's sessions at once. Each change is written to the security audit.
 * @param {import('pg').Pool} pool
 * @param {string} actorId the owner making the change
 * @param {string} userId
 * @param {{ role?: string, enabled?: boolean }} changes
 */
export async function updateUser(pool, actorId, userId, { role, enabled } = {}) {
  if (role !== undefined && !['admin', 'user'].includes(role))
    throw new UserError('Role must be admin or user.');
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new UserError('Invalid status.');
  if (role === undefined && enabled === undefined) throw new UserError('Nothing to change.');
  return writeTransaction(pool, async (client) => {
    const target = (
      await client.query(
        `SELECT a.role, u."emailVerified" AS verified FROM user_access a
         JOIN auth_user u ON u.id = a.user_id WHERE a.user_id = $1 FOR UPDATE OF a`,
        [userId],
      )
    ).rows[0];
    if (!target) throw new UserError('Account not found.');
    if (target.role === 'owner')
      throw new UserError('The owner changes only through the operator commands.');
    if (role !== undefined && !target.verified)
      throw new UserError('Only a verified account can be given a role.');
    const audit = (action) =>
      // The local-mode owner has no account row, so the actor is recorded only when it exists.
      client.query(
        `INSERT INTO security_audit(action, user_id, subject_id)
         VALUES ($1, (SELECT id FROM auth_user WHERE id = $2), $3)`,
        [action, actorId, userId],
      );
    if (role !== undefined && role !== target.role) {
      await client.query('UPDATE user_access SET role = $2 WHERE user_id = $1', [userId, role]);
      await audit('user.role.' + role);
    }
    if (enabled !== undefined) {
      await client.query('UPDATE user_access SET enabled = $2 WHERE user_id = $1', [
        userId,
        enabled,
      ]);
      if (!enabled) await client.query('DELETE FROM auth_session WHERE "userId" = $1', [userId]);
      await audit(enabled ? 'user.enabled' : 'user.disabled');
    }
    return null;
  });
}

/**
 * Accounts never verified within `days` of creation (an open sign-up left unfinished). Counts
 * them, and with `apply` deletes them; their sessions, grants and saved items go with them.
 * @param {import('pg').Pool | import('pg').PoolClient} client
 */
export async function removeUnverifiedAccounts(client, { days = 7, apply = false } = {}) {
  const predicate = `"emailVerified" = false AND "createdAt" < now() - make_interval(days => $1)
    AND id NOT IN (SELECT user_id FROM user_access WHERE role = 'owner')`;
  const count = (
    await client.query(`SELECT count(*)::int AS n FROM auth_user WHERE ${predicate}`, [days])
  ).rows[0].n;
  if (apply && count) await client.query(`DELETE FROM auth_user WHERE ${predicate}`, [days]);
  return count;
}
