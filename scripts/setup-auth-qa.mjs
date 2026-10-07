// Synthetic browser fixtures only. Never seed QA records into the normal database.
import { Pool } from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { loadLocalEnv } from './load-env.mjs';
loadLocalEnv();
const url = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(url.hostname))
  throw Error('QA setup requires local PostgreSQL');
const name = url.pathname.slice(1) + '_p3_qa';
if (!/^[a-z0-9_]+$/.test(name)) throw Error('Unsupported local database name');
const pool = new Pool({ connectionString: url.href });
try {
  if (!(await pool.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount)
    await pool.query(`CREATE DATABASE ${name}`);
} finally {
  await pool.end();
}
url.pathname = '/' + name;
const overrides = {
  DATABASE_URL: url.href,
  WINNIGO_REPOSITORY: 'postgres',
  WINNIGO_STORAGE: 's3',
  S3_PREFIX: 'p3-qa-photos/',
  WINNIGO_SEED_PROFILE: 'qa',
  WINNIGO_AUTH_MODE: 'session',
  WINNIGO_MAIL_MODE: 'file',
  WINNIGO_MAIL_DIR: '.winnigo/p3-mail',
  WINNIGO_ORIGIN: 'http://127.0.0.1:5193',
  WINNIGO_HOST: '127.0.0.1',
  PORT: '5193',
};
for (const script of ['migrate-postgres.mjs', 'seed-node.mjs']) {
  const result = spawnSync(process.execPath, ['scripts/' + script], {
    env: { ...process.env, ...overrides },
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
await mkdir('.winnigo', { recursive: true, mode: 0o700 });
await writeFile(
  '.winnigo/p3-qa.env',
  Object.entries(overrides)
    .map(([k, v]) => k + '=' + JSON.stringify(v))
    .join('\n') + '\n',
  { mode: 0o600 },
);
console.log(
  'Synthetic QA database ready. Start with node --env-file=.winnigo/p3-qa.env scripts/node-app.mjs start',
);
