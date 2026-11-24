// npm run db:restore -- --into winnigo_restore_test [--from postgres/winnigo-….dump]
//
// Restores a dump from the backup bucket (the newest unless --from names one) into the named
// database on the same server, creating it if needed, then prints row counts to compare with
// the live site. Restoring over the live database is refused; to roll back, restore into a new
// database, check it, then point DATABASE_URL at it (docs/32-deployment.md).
import { spawn } from 'node:child_process';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import pg from 'pg';
import { backupBucket, listBackups, postgresTarget } from './backup-database.mjs';
import { loadLocalEnv } from './load-env.mjs';

loadLocalEnv();
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const into = option('--into');
if (!into || !/^[a-z][a-z0-9_]{0,62}$/.test(into))
  throw Error('Name the database to restore into: --into winnigo_restore_test');
const live = new URL(process.env.DATABASE_URL);
if (live.pathname.slice(1) === into)
  throw Error('Refusing to restore over the live database; restore into a new one.');

const target = backupBucket();
const key = option('--from') || (await listBackups(target))[0]?.key;
if (!key) throw Error('No backups found.');
const object = await target.client.send(new GetObjectCommand({ Bucket: target.bucket, Key: key }));
const bytes = Buffer.from(await object.Body.transformToByteArray());

const admin = new pg.Client({ connectionString: live.href });
await admin.connect();
try {
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [into]);
  if (exists.rowCount)
    throw Error(`Database ${into} already exists; drop it or choose another name.`);
  await admin.query(`CREATE DATABASE ${into}`);
} finally {
  await admin.end();
}

const restored = new URL(live.href);
restored.pathname = '/' + into;
const { url, env } = postgresTarget(restored.href);
const child = spawn('pg_restore', ['--no-owner', '--exit-on-error', '--dbname', url], {
  env,
  stdio: ['pipe', 'inherit', 'inherit'],
});
child.stdin.end(bytes);
const code = await new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('close', resolve);
});
if (code !== 0) throw Error(`pg_restore failed with code ${code}`);

const check = new pg.Client({ connectionString: restored.href });
await check.connect();
try {
  const { rows } = await check.query(`
    SELECT 'listings' AS "table", count(*)::int AS rows FROM listings
    UNION ALL SELECT 'events', count(*)::int FROM events
    UNION ALL SELECT 'accounts', count(*)::int FROM auth_user
    UNION ALL SELECT 'saved items', count(*)::int FROM saved_items
    UNION ALL SELECT 'migrations', count(*)::int FROM winnigo_schema_migrations`);
  console.log(`Restored ${key} into ${into}:`);
  console.table(rows);
} finally {
  await check.end();
}
