// Applies numbered SQL migrations from migrations/postgres in order, then installs or upgrades the
// pg-boss job tables and the collection queue (npm run db:migrate).
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
    await client.query(
      await readFile(
        new URL('../migrations/postgres/0001_foundation.sql', import.meta.url),
        'utf8',
      ),
    );
    const files = (await readdir(new URL('../migrations/postgres/', import.meta.url)))
      .filter((f) => /^\d+.*\.sql$/.test(f))
      .sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (
        (await client.query('SELECT 1 FROM winnigo_schema_migrations WHERE version=$1', [version]))
          .rowCount
      )
        continue;
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
  } catch {
    await client.query('ROLLBACK');
    throw Error('Migration failed');
  } finally {
    client.release();
  }
} catch {
  console.error('PostgreSQL migration failed. Check service availability and configuration.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
