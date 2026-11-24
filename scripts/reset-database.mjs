// Drops every Winnigo table and job in the local database so `npm run db:migrate` can build it
// from the baseline again (npm run db:reset -- --yes). Only a loopback or Compose database is
// accepted, and nothing happens without --yes. Private media in S3 is left alone; run
// npm run media:cleanup afterwards to remove photos no listing references.
import { Pool } from 'pg';
import { loadLocalEnv } from './load-env.mjs';
import { serviceConfig } from './check-services.mjs';
import { jobsSchema } from '../lib/server/job-queue.mjs';

loadLocalEnv();
const { connectionString } = serviceConfig();
const host = new URL(connectionString).hostname;
if (!['127.0.0.1', 'localhost', '::1', '[::1]', 'postgres'].includes(host)) {
  console.error('db:reset only resets a local database (loopback or the Compose service).');
  process.exit(1);
}
if (!process.argv.includes('--yes')) {
  console.error('This removes every listing, event, account and run in the local database.');
  console.error('Run npm run db:reset -- --yes to continue.');
  process.exit(1);
}
const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
try {
  await pool.query(`DROP SCHEMA IF EXISTS ${jobsSchema()} CASCADE`);
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  console.log('Local database reset. Run npm run db:migrate, then npm run db:seed.');
} catch {
  console.error('Reset failed. Check that the database is running (npm run services:up).');
  process.exitCode = 1;
} finally {
  await pool.end();
}
