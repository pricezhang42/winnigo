// Previews (or with --apply removes) expired sessions, verifications, invitations, rate-limit
// buckets and old audit/credential rows (npm run accounts:cleanup).
import { loadLocalEnv } from './load-env.mjs';
import { database, writeTransaction } from '../lib/server/postgres.mjs';
loadLocalEnv();
const pool = database(),
  apply = process.argv.includes('--apply');
const targets = [
  ['security_audit', "created_at<now()-interval '90 days'"],
  ['request_limits', "window_start<now()-interval '1 day'"],
  ['auth_session', '"expiresAt"<now()'],
  ['auth_verification', '"expiresAt"<now()'],
  ['account_invitations', 'expires_at<now()'],
  ['service_credentials', "coalesce(revoked_at,expires_at)<now()-interval '90 days'"],
];
try {
  const result = await writeTransaction(pool, async (c) => {
    const counts = {};
    for (const [table, predicate] of targets) {
      counts[table] = (
        await c.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${predicate}`)
      ).rows[0].count;
      if (apply) await c.query(`DELETE FROM ${table} WHERE ${predicate}`);
    }
    return counts;
  });
  console.log(JSON.stringify({ dryRun: !apply, counts: result }));
} finally {
  await pool.end();
}
