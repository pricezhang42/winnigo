// Operator-only account commands (see docs/16-p3-accounts.md). Do not expose this script
// through an HTTP shell. Usage: npm run accounts:manage -- COMMAND [ARGS...]
import { writeFile } from 'node:fs/promises';
import { loadLocalEnv } from './load-env.mjs';
import { database, writeTransaction } from '../lib/server/postgres.mjs';
import { bootstrapOwner, issueCredential } from '../lib/server/access.mjs';

const USAGE =
  'Commands: invite EMAIL; bootstrap-owner EMAIL; transfer-owner FROM_EMAIL TO_EMAIL; role EMAIL admin|user; disable EMAIL; grant-source|revoke-source EMAIL SOURCE; grant-listing|revoke-listing EMAIL ID; issue-collector facebook LABEL FILE; revoke-collector ID';

loadLocalEnv();
const pool = database();
const [command, subject, value, extra] = process.argv.slice(2);

/** Allows registration for an email for seven days. Does not send a message. */
async function invite(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '') || email.length > 254)
    throw Error('Provide a valid email');
  await pool.query(
    "INSERT INTO account_invitations(email) VALUES($1) ON CONFLICT(email) DO UPDATE SET expires_at=now()+interval '7 days'",
    [email.toLowerCase()],
  );
}

/** Atomically makes `toEmail` (verified, enabled) the owner and demotes the current owner to admin. */
async function transferOwner(fromEmail, toEmail) {
  await writeTransaction(pool, async (client) => {
    const current = (
      await client.query(
        "SELECT user_id FROM user_access JOIN auth_user ON id=user_id WHERE role='owner' AND lower(email)=$1",
        [fromEmail.toLowerCase()],
      )
    ).rows[0];
    const next = (
      await client.query(
        'SELECT user_id FROM user_access JOIN auth_user ON id=user_id WHERE enabled AND "emailVerified" AND lower(email)=$1',
        [toEmail.toLowerCase()],
      )
    ).rows[0];
    if (!current || !next || current.user_id === next.user_id)
      throw Error('Existing owner and different verified target required');
    await client.query("UPDATE user_access SET role='admin' WHERE user_id=$1", [current.user_id]);
    await client.query("UPDATE user_access SET role='owner' WHERE user_id=$1", [next.user_id]);
  });
}

/** Sets a verified non-owner's role to admin or user. Ownership only moves via transfer-owner. */
async function setRole(email, role) {
  if (!['admin', 'user'].includes(role))
    throw Error('Use admin or user; ownership uses bootstrap-owner');
  const result = await pool.query(
    'UPDATE user_access SET role=$2 WHERE user_id=(SELECT id FROM auth_user WHERE lower(email)=$1 AND "emailVerified"=true) AND role<>\'owner\' RETURNING user_id',
    [email.toLowerCase(), role],
  );
  if (!result.rowCount) throw Error('Verified non-owner account required');
}

/** Disables a non-owner account and revokes its sessions immediately. */
async function disable(email) {
  await writeTransaction(pool, async (client) => {
    const result = await client.query(
      "UPDATE user_access SET enabled=false WHERE user_id=(SELECT id FROM auth_user WHERE lower(email)=$1) AND role<>'owner' RETURNING user_id",
      [email.toLowerCase()],
    );
    if (!result.rowCount) throw Error('Non-owner account required');
    await client.query('DELETE FROM auth_session WHERE "userId"=$1', [result.rows[0].user_id]);
  });
}

/** grant-source / revoke-source / grant-listing / revoke-listing for one account. */
async function changeGrant(email, target) {
  const user = (
    await pool.query('SELECT id FROM auth_user WHERE lower(email)=$1', [email.toLowerCase()])
  ).rows[0];
  if (!user) throw Error('Account not found');
  const bySource = command.endsWith('source');
  const table = bySource ? 'source_grants' : 'listing_grants';
  const column = bySource ? 'source_id' : 'listing_id';
  if (command.startsWith('grant'))
    await pool.query(
      `INSERT INTO ${table}(user_id,${column}) VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [user.id, target],
    );
  else
    await pool.query(`DELETE FROM ${table} WHERE user_id=$1 AND ${column}=$2`, [user.id, target]);
}

/**
 * Issues a source-scoped collector token and writes it once to a new mode-0600 file. If the file
 * cannot be created, the credential is deleted so no unrecorded token stays valid.
 */
async function issueCollector(source, label, file) {
  if (!file) throw Error('Use issue-collector facebook LABEL /private/token.json');
  const credential = await issueCredential({ source, label }, pool);
  try {
    await writeFile(file, JSON.stringify(credential), { mode: 0o600, flag: 'wx' });
  } catch {
    await pool.query('DELETE FROM service_credentials WHERE id=$1', [credential.id]);
    throw Error('Choose a new private token file');
  }
}

async function revokeCollector(id) {
  await pool.query('UPDATE service_credentials SET revoked_at=now() WHERE id=$1', [id]);
}

const COMMANDS = {
  invite: () => invite(subject),
  'bootstrap-owner': () => bootstrapOwner(subject, pool),
  'transfer-owner': () => transferOwner(subject, value),
  role: () => setRole(subject, value),
  disable: () => disable(subject),
  'grant-source': () => changeGrant(subject, value),
  'revoke-source': () => changeGrant(subject, value),
  'grant-listing': () => changeGrant(subject, value),
  'revoke-listing': () => changeGrant(subject, value),
  'issue-collector': () => issueCollector(subject, value, extra),
  'revoke-collector': () => revokeCollector(subject),
};

try {
  if (!Object.hasOwn(COMMANDS, command)) throw Error(USAGE);
  await COMMANDS[command]();
  await pool.query('INSERT INTO security_audit(action) VALUES($1)', ['operator.' + command]);
  console.log('Account operation completed.');
} catch (error) {
  // Only the usage text is printed; other error details are not shown.
  console.error(
    error.message?.startsWith('Commands:')
      ? error.message
      : 'Account operation failed. Check command arguments, account state and configuration.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
