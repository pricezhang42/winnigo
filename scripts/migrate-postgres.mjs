// Applies numbered SQL migrations from migrations/postgres in order, then installs or upgrades the
// pg-boss job tables and the collection queue (npm run db:migrate). 0001_baseline replaced the
// earlier migrations (docs/30); a database built by them is reset once with npm run db:reset.
import { Pool } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { loadLocalEnv } from './load-env.mjs';
import { serviceConfig } from './check-services.mjs';
import { createBoss, ensureCollectionQueue } from '../lib/server/job-queue.mjs';
loadLocalEnv();
const pool = new Pool({
  connectionString: serviceConfig().connectionString,
  connectionTimeoutMillis: 5000,
});
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('winnigo-migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS winnigo_schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Set(
      (await client.query('SELECT version FROM winnigo_schema_migrations')).rows.map(
        (row) => row.version,
      ),
    );
    if (applied.size && !applied.has('0001_baseline')) {
      console.error(
        'This database was built by the migrations the baseline replaced. Reset it once with ' +
          'npm run db:reset -- --yes (local data is removed), then run npm run db:migrate.',
      );
      throw Error('Pre-baseline database');
    }
    const files = (await readdir(new URL('../migrations/postgres/', import.meta.url)))
      .filter((f) => /^\d+.*\.sql$/.test(f))
      .sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) continue;
      await client.query(
        await readFile(new URL('../migrations/postgres/' + file, import.meta.url), 'utf8'),
      );
      await client.query('INSERT INTO winnigo_schema_migrations(version) VALUES ($1)', [version]);
    }
    await client.query('COMMIT');
    console.log('PostgreSQL migrations applied.');
    const boss = createBoss({ connectionString: serviceConfig().connectionString, migrate: true });
    await boss.start();
    try {
      await ensureCollectionQueue(boss);
    } finally {
      await boss.stop({ graceful: false });
    }
    console.log('Job queue tables ready.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error.message === 'Pre-baseline database' ? error : Error('Migration failed');
  } finally {
    client.release();
  }
} catch (error) {
  if (error.message !== 'Pre-baseline database')
    console.error('PostgreSQL migration failed. Check service availability and configuration.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
