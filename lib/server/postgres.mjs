import { Pool } from 'pg';
const pools = (globalThis.__winnigoPools ??= new Map());
export function database(url = process.env.DATABASE_URL) {
  if (!url) throw Error('DATABASE_URL is required');
  if (!pools.has(url))
    pools.set(
      url,
      new Pool({
        connectionString: url,
        max: 8,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 10000,
        allowExitOnIdle: true,
      }),
    );
  return pools.get(url);
}
export async function writeTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('winnigo-write'))");
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
