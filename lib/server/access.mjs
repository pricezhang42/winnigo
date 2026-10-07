import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { localDay } from '../connectors.mjs';
import { database, writeTransaction } from './postgres.mjs';

/** Hex SHA-256. Used so raw tokens and rate-limit keys are never stored. */
export const digest = (value) => createHash('sha256').update(value).digest('hex');

export const isAdmin = (principal) => ['owner', 'admin'].includes(principal?.role);

/**
 * SQL condition limiting `alias` (a listings table alias) to rows the principal may read:
 * everything for the owner, nothing when signed out, otherwise public listings plus any
 * source or listing explicitly granted to the user.
 *
 * One predicate is shared by search, facets, detail and media reads. No role or user ID is
 * taken from the request query, body or forwarded identity headers.
 */
export function accessClause(principal, bind, alias = 'listings') {
  if (principal?.role === 'owner') return 'true';
  if (!principal?.userId) return 'false';
  const userId = bind(principal.userId);
  return `(
    ${alias}.visibility = 'public'
    OR EXISTS (SELECT 1 FROM source_grants g WHERE g.user_id = ${userId} AND g.source_id = ${alias}.source)
    OR EXISTS (SELECT 1 FROM listing_grants g WHERE g.user_id = ${userId} AND g.listing_id = ${alias}.id)
  )`;
}

/**
 * Fixed-window rate limit stored in PostgreSQL. Returns false once `key` has been used more
 * than `max` times in the current `seconds`-long window. The key is hashed before storage.
 */
export async function rateLimit(key, max = 60, seconds = 60, pool = database()) {
  const windowExpired = `request_limits.window_start < now() - $2 * interval '1 second'`;
  const result = await pool.query(
    `INSERT INTO request_limits(key, window_start, count) VALUES ($1, now(), 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN ${windowExpired} THEN 1 ELSE request_limits.count + 1 END,
       window_start = CASE WHEN ${windowExpired} THEN now() ELSE request_limits.window_start END
     RETURNING count`,
    [digest(key), seconds],
  );
  return result.rows[0].count <= max;
}

/** The active, unexpired collector credential matching the request's token header, if any. */
export async function serviceCredential(headers, pool = database()) {
  const token = headers.get('x-winnigo-collector-key');
  if (!token || token.length > 200) return null;
  const result = await pool.query(
    'SELECT id,source_id FROM service_credentials WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()',
    [digest(token)],
  );
  return result.rows[0] || null;
}
/**
 * Creates a source-scoped collector token. Only its hash is stored; the caller must save the
 * returned token, which cannot be recovered later.
 */
export async function issueCredential({ source, label, days = 90 }, pool = database()) {
  if (
    source !== 'facebook' ||
    !label?.trim() ||
    label.length > 100 ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 365
  )
    throw Error('A Facebook collector label and 1–365 day lifetime are required');
  const id = randomUUID();
  const token = 'wgc_' + randomBytes(32).toString('base64url');
  await writeTransaction(pool, async (client) => {
    await client.query('INSERT INTO sources(id,report) VALUES($1,$2) ON CONFLICT DO NOTHING', [
      source,
      { id: source, status: 'pending', count: 0, checkedAt: '' },
    ]);
    await client.query(
      "INSERT INTO service_credentials(id,token_hash,source_id,label,expires_at) VALUES($1,$2,$3,$4,now()+$5*interval '1 day')",
      [id, digest(token), source, label, days],
    );
  });
  return { id, token };
}
/** Promotes an existing verified account to owner. Refuses if an owner already exists. */
export async function bootstrapOwner(email, pool = database()) {
  return writeTransaction(pool, async (client) => {
    if ((await client.query("SELECT 1 FROM user_access WHERE role='owner'")).rowCount)
      throw Error('Owner already configured');
    const user = (
      await client.query(
        'SELECT id FROM auth_user WHERE lower(email)=$1 AND "emailVerified"=true',
        [email.toLowerCase()],
      )
    ).rows[0];
    if (!user) throw Error('An existing verified account is required');
    await client.query("UPDATE user_access SET role='owner',enabled=true WHERE user_id=$1", [
      user.id,
    ]);
    await client.query(
      "INSERT INTO security_audit(action,user_id) VALUES('owner.bootstrapped',$1)",
      [user.id],
    );
  });
}
/** A photo is readable only through a current listing the principal may read. */
export async function canReadMedia(id, principal, pool = database()) {
  if (principal?.role === 'owner') return true;
  const values = [id];
  const bind = (value) => {
    values.push(value);
    return '$' + values.length;
  };
  const readable = accessClause(principal, bind, 'l');
  const result = await pool.query(
    `SELECT 1
     FROM listing_media m
     JOIN listings l ON l.id = m.listing_id
     WHERE m.media_id = $1
       AND NOT l.hidden
       AND coalesce(l.document->>'status', 'active') NOT IN ('hidden', 'cancelled')
       AND coalesce(l.document->>'end', '9999-12-31') >= ${bind(localDay())}
       AND ${readable}
     LIMIT 1`,
    values,
  );
  return !!result.rowCount;
}
