// npm run db:backup            dump the database to the backup bucket, then prune old dumps
// npm run db:backup -- --list  list the stored dumps, newest first
//
// Dumps PostgreSQL with pg_dump (custom format) into BACKUP_S3_BUCKET under `postgres/`, using
// the S3 endpoint and, unless BACKUP_S3_ACCESS_KEY/BACKUP_S3_SECRET_KEY are set, the media
// credentials. Dumps older than BACKUP_RETENTION_DAYS (default 30) are deleted, always keeping
// the newest seven. Restore with `npm run db:restore` (docs/32-deployment.md).
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { loadLocalEnv } from './load-env.mjs';

loadLocalEnv();
const PREFIX = 'postgres/';
const KEEP_AT_LEAST = 7;

/** The backup bucket's client and name, from the environment. */
export function backupBucket(env = process.env) {
  const bucket = env.BACKUP_S3_BUCKET;
  if (!bucket) throw Error('Set BACKUP_S3_BUCKET to the private bucket for database backups.');
  if (bucket === env.S3_BUCKET)
    throw Error('Use a separate bucket for backups, not the media one.');
  const client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.BACKUP_S3_ACCESS_KEY || env.S3_ACCESS_KEY,
      secretAccessKey: env.BACKUP_S3_SECRET_KEY || env.S3_SECRET_KEY,
    },
  });
  return { client, bucket };
}

/** Stored dumps, newest first. */
export async function listBackups({ client, bucket }) {
  const items = [];
  let token;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ContinuationToken: token }),
    );
    items.push(...(page.Contents || []));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return items
    .map((item) => ({ key: item.Key, size: item.Size, at: item.LastModified }))
    .sort((a, b) => b.key.localeCompare(a.key));
}

/** pg_dump/pg_restore arguments and environment for a database URL, password kept off argv. */
export function postgresTarget(databaseUrl) {
  const url = new URL(databaseUrl);
  const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };
  url.password = '';
  return { url: url.href, env };
}

async function dump() {
  const { url, env } = postgresTarget(process.env.DATABASE_URL);
  const child = spawn('pg_dump', ['--format=custom', '--no-owner', '--dbname', url], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  let errors = '';
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => (errors += chunk));
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (code !== 0) throw Error(`pg_dump failed: ${errors.trim().slice(0, 500)}`);
  return Buffer.concat(chunks);
}

async function backup() {
  const target = backupBucket();
  const days = Number(process.env.BACKUP_RETENTION_DAYS || 30);
  if (!Number.isInteger(days) || days < 1)
    throw Error('BACKUP_RETENTION_DAYS must be a whole number.');
  const bytes = await dump();
  const key = `${PREFIX}winnigo-${new Date().toISOString().replace(/[-:]|\.\d+/g, '')}.dump`;
  await target.client.send(
    new PutObjectCommand({
      Bucket: target.bucket,
      Key: key,
      Body: bytes,
      ContentType: 'application/octet-stream',
    }),
  );
  const cutoff = Date.now() - days * 86400_000;
  const old = (await listBackups(target))
    .slice(KEEP_AT_LEAST)
    .filter((item) => new Date(item.at).getTime() < cutoff);
  if (old.length)
    await target.client.send(
      new DeleteObjectsCommand({
        Bucket: target.bucket,
        Delete: { Objects: old.map((item) => ({ Key: item.key })) },
      }),
    );
  console.log(
    `Backed up ${(bytes.length / 1e6).toFixed(1)} MB to ${key}; removed ${old.length} older dumps.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--list'))
    for (const item of await listBackups(backupBucket()))
      console.log(`${item.key}\t${(item.size / 1e6).toFixed(1)} MB\t${item.at.toISOString()}`);
  else await backup();
}
