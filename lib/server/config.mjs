import { resolve } from 'node:path';
const loopback = (host) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);

/**
 * Reads and validates server configuration from the environment. Throws a message naming the
 * problem (never the secret value) when the combination is unsafe or incomplete.
 *
 * - `WINNIGO_AUTH_MODE`: `local` (password-free, loopback only), `basic` (single owner
 *   password) or `session` (invited accounts; needs PostgreSQL, a secret and HTTPS off loopback).
 * - `WINNIGO_REPOSITORY`/`WINNIGO_STORAGE`: `fixture` files, or `postgres` + `s3` together.
 */
export function readConfig(env = process.env) {
  const mode = env.WINNIGO_AUTH_MODE || 'basic';
  if (!['basic', 'local', 'session'].includes(mode))
    throw Error('WINNIGO_AUTH_MODE must be basic, local or session.');
  const host = env.WINNIGO_HOST || '127.0.0.1';
  if (mode === 'local' && !loopback(host))
    throw Error('Password-free local mode requires a loopback WINNIGO_HOST.');
  if (mode === 'basic' && (!env.WINNIGO_ADMIN_USER || !env.WINNIGO_ADMIN_PASSWORD))
    throw Error('Owner credentials are required in basic mode. Run npm run setup.');
  const repository = env.WINNIGO_REPOSITORY || 'fixture';
  const storage = env.WINNIGO_STORAGE || 'fixture';
  if (!['fixture', 'postgres'].includes(repository) || !['fixture', 's3'].includes(storage))
    throw Error('Unsupported repository or storage adapter.');
  if ((repository === 'postgres') !== (storage === 's3'))
    throw Error('Select postgres and s3 together.');
  if (repository === 'postgres') {
    for (const key of [
      'DATABASE_URL',
      'S3_ENDPOINT',
      'S3_BUCKET',
      'S3_REGION',
      'S3_ACCESS_KEY',
      'S3_SECRET_KEY',
    ])
      if (!env[key]) throw Error(`Missing ${key}`);
    try {
      if (
        !['postgres:', 'postgresql:'].includes(new URL(env.DATABASE_URL).protocol) ||
        !['http:', 'https:'].includes(new URL(env.S3_ENDPOINT).protocol)
      )
        throw Error();
    } catch {
      throw Error('Invalid database or S3 URL');
    }
  }

  if (
    mode === 'session' &&
    (repository !== 'postgres' || !env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32)
  )
    throw Error('Session mode requires PostgreSQL and a random BETTER_AUTH_SECRET');
  const port = Number(env.PORT || 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error('PORT must be between 1 and 65535.');
  const origin = env.WINNIGO_ORIGIN || `http://${host === '::1' ? '[::1]' : host}:${port}`;
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    throw Error('WINNIGO_ORIGIN must be a valid HTTP(S) origin.');
  }
  if (
    !['http:', 'https:'].includes(originUrl.protocol) ||
    originUrl.username ||
    originUrl.password ||
    originUrl.pathname !== '/' ||
    originUrl.search ||
    originUrl.hash
  )
    throw Error('WINNIGO_ORIGIN must be an HTTP(S) origin without credentials or path.');
  if (mode === 'local' && !loopback(originUrl.hostname))
    throw Error('Local mode requires a loopback WINNIGO_ORIGIN.');
  if (mode === 'session' && !loopback(originUrl.hostname) && originUrl.protocol !== 'https:')
    throw Error('Session mode requires HTTPS outside loopback');
  const profile = env.WINNIGO_SEED_PROFILE || 'snapshot';
  if (!['snapshot', 'qa'].includes(profile))
    throw Error('WINNIGO_SEED_PROFILE must be snapshot or qa.');
  return {
    repository,
    storage,
    host,
    port,
    origin: originUrl.origin,
    mode,
    profile,
    dataDir: resolve(env.WINNIGO_DATA_DIR || '.winnigo/node'),
    auth: {
      WINNIGO_AUTH_MODE: mode,
      WINNIGO_ADMIN_USER: env.WINNIGO_ADMIN_USER,
      WINNIGO_ADMIN_PASSWORD: env.WINNIGO_ADMIN_PASSWORD,
      WINNIGO_COLLECTOR_KEY: env.WINNIGO_COLLECTOR_KEY,
    },
  };
}
