// What the account page shows a signed-in person (docs/31): how they sign in, how many
// discoveries they saved, and their signed-in devices. Read on the server, so session tokens
// never reach the page.
import { deviceLabel } from '../device-label.mjs';

const MAX_DEVICES = 20;

/**
 * @param {import('pg').Pool} pool
 * @param {string} userId
 * @param {string | undefined} currentSessionId the session making this request
 */
export async function accountOverview(pool, userId, currentSessionId) {
  const [methods, saved, sessions] = await Promise.all([
    pool.query('SELECT DISTINCT "providerId" FROM auth_account WHERE "userId"=$1', [userId]),
    pool.query('SELECT count(*)::int AS count FROM saved_items WHERE user_id=$1', [userId]),
    pool.query(
      `SELECT id, "userAgent", "updatedAt" FROM auth_session
        WHERE "userId"=$1 AND "expiresAt" > now()
        ORDER BY (id = $2) DESC, "updatedAt" DESC LIMIT $3`,
      [userId, currentSessionId ?? '', MAX_DEVICES],
    ),
  ]);
  return {
    methods: methods.rows.map((row) => row.providerId).sort(),
    saved: saved.rows[0].count,
    devices: sessions.rows.map((row) => ({
      id: row.id,
      label: deviceLabel(row.userAgent),
      // Sessions are extended at most once a day, so this is the day of last use.
      lastActive: new Date(row.updatedAt).toISOString(),
      current: row.id === currentSessionId,
    })),
  };
}
