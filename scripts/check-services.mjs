import { Pool } from 'pg';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import { loadLocalEnv } from './load-env.mjs';
loadLocalEnv();
export function serviceConfig(env = process.env) {
  for (const name of [
    'DATABASE_URL',
    'S3_ENDPOINT',
    'S3_REGION',
    'S3_BUCKET',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
  ])
    if (!env[name]) throw Error(`Missing ${name}; run npm run setup.`);
  let database, endpoint;
  try {
    database = new URL(env.DATABASE_URL);
    endpoint = new URL(env.S3_ENDPOINT);
  } catch {
    throw Error('Invalid database or storage URL.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['http:', 'https:'].includes(endpoint.protocol)
  )
    throw Error('Invalid database or storage protocol.');
  if (endpoint.username || endpoint.password) throw Error('Use separate S3 credentials.');
  return {
    connectionString: env.DATABASE_URL,
    s3: {
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
    },
    bucket: env.S3_BUCKET,
  };
}
export async function checkServices() {
  const c = serviceConfig();
  const pool = new Pool({ connectionString: c.connectionString, connectionTimeoutMillis: 5000 });
  const s3 = new S3Client(c.s3);
  try {
    await pool.query('SELECT 1');
    await s3.send(new HeadBucketCommand({ Bucket: c.bucket }), {
      abortSignal: AbortSignal.timeout(10000),
    });
    console.log('PostgreSQL and private S3 bucket are reachable.');
  } finally {
    await pool.end();
    s3.destroy();
  }
}
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1])
  checkServices().catch(() => {
    console.error(
      'Development services are unavailable. Check configuration and npm run services:up.',
    );
    process.exitCode = 1;
  });
