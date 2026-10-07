// Operator-only commands. Do not expose this script through an HTTP shell.
import { writeFile } from 'node:fs/promises';
import { loadLocalEnv } from './load-env.mjs';
import { database, writeTransaction } from '../lib/server/postgres.mjs';
import { bootstrapOwner, issueCredential } from '../lib/server/access.mjs';
loadLocalEnv();
const pool = database();
const [command, subject, value, extra] = process.argv.slice(2);
try {
  if (command === 'invite') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject || '') || subject.length > 254)
      throw Error('Provide a valid email');
    await pool.query(
      "INSERT INTO account_invitations(email) VALUES($1) ON CONFLICT(email) DO UPDATE SET expires_at=now()+interval '7 days'",
      [subject.toLowerCase()],
    );
  } else if (command === 'bootstrap-owner') await bootstrapOwner(subject, pool);
  else if (command === 'transfer-owner') {
    await writeTransaction(pool, async (c) => {
      const old = (
        await c.query(
          "SELECT user_id FROM user_access JOIN auth_user ON id=user_id WHERE role='owner' AND lower(email)=$1",
          [subject.toLowerCase()],
        )
      ).rows[0];
      const next = (
        await c.query(
          'SELECT user_id FROM user_access JOIN auth_user ON id=user_id WHERE enabled AND "emailVerified" AND lower(email)=$1',
          [value.toLowerCase()],
        )
      ).rows[0];
      if (!old || !next || old.user_id === next.user_id)
        throw Error('Existing owner and different verified target required');
      await c.query("UPDATE user_access SET role='admin' WHERE user_id=$1", [old.user_id]);
      await c.query("UPDATE user_access SET role='owner' WHERE user_id=$1", [next.user_id]);
    });
  } else if (command === 'role') {
    if (!['admin', 'user'].includes(value))
      throw Error('Use admin or user; ownership uses bootstrap-owner');
    const result = await pool.query(
      'UPDATE user_access SET role=$2 WHERE user_id=(SELECT id FROM auth_user WHERE lower(email)=$1 AND "emailVerified"=true) AND role<>\'owner\' RETURNING user_id',
      [subject.toLowerCase(), value],
    );
    if (!result.rowCount) throw Error('Verified non-owner account required');
  } else if (command === 'disable') {
    await writeTransaction(pool, async (c) => {
      const r = await c.query(
        "UPDATE user_access SET enabled=false WHERE user_id=(SELECT id FROM auth_user WHERE lower(email)=$1) AND role<>'owner' RETURNING user_id",
        [subject.toLowerCase()],
      );
      if (!r.rowCount) throw Error('Non-owner account required');
      await c.query('DELETE FROM auth_session WHERE "userId"=$1', [r.rows[0].user_id]);
    });
  } else if (
    ['grant-source', 'revoke-source', 'grant-listing', 'revoke-listing'].includes(command)
  ) {
    const user = (
      await pool.query('SELECT id FROM auth_user WHERE lower(email)=$1', [subject.toLowerCase()])
    ).rows[0];
    if (!user) throw Error('Account not found');
    const source = command.endsWith('source'),
      table = source ? 'source_grants' : 'listing_grants',
      column = source ? 'source_id' : 'listing_id';
    if (command.startsWith('grant'))
      await pool.query(
        `INSERT INTO ${table}(user_id,${column}) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [user.id, value],
      );
    else
      await pool.query(`DELETE FROM ${table} WHERE user_id=$1 AND ${column}=$2`, [user.id, value]);
  } else if (command === 'issue-collector') {
    if (!extra) throw Error('Use issue-collector facebook LABEL /private/token.json');
    const credential = await issueCredential({ source: subject, label: value }, pool);
    try {
      await writeFile(extra, JSON.stringify(credential), { mode: 0o600, flag: 'wx' });
    } catch {
      await pool.query('DELETE FROM service_credentials WHERE id=$1', [credential.id]);
      throw Error('Choose a new private token file');
    }
  } else if (command === 'revoke-collector')
    await pool.query('UPDATE service_credentials SET revoked_at=now() WHERE id=$1', [subject]);
  else
    throw Error(
      'Commands: invite EMAIL; bootstrap-owner EMAIL; transfer-owner FROM_EMAIL TO_EMAIL; role EMAIL admin|user; disable EMAIL; grant-source|revoke-source EMAIL SOURCE; grant-listing|revoke-listing EMAIL ID; issue-collector facebook LABEL FILE; revoke-collector ID',
    );
  await pool.query('INSERT INTO security_audit(action) VALUES($1)', ['operator.' + command]);
  console.log('Account operation completed.');
} catch (e) {
  console.error(
    e.message?.startsWith('Commands:')
      ? e.message
      : 'Account operation failed. Check command arguments, account state and configuration.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
