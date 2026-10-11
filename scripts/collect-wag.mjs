// Default is a dry run. --enqueue explicitly queues a saved collection in the configured database.
import { loadLocalEnv } from './load-env.mjs';
import { sources } from '../lib/connectors.mjs';
import { collectWag } from '../lib/server/wag.mjs';

loadLocalEnv();
try {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--enqueue'))
    throw Error('Usage: npm run collect:wag [-- --enqueue]');
  if (args.includes('--enqueue')) {
    const { readConfig } = await import('../lib/server/config.mjs');
    if (readConfig().repository !== 'postgres')
      throw Error('Queued collection requires PostgreSQL');
    const { database } = await import('../lib/server/postgres.mjs');
    const { createBoss, enqueueCollection } = await import('../lib/server/job-queue.mjs');
    const boss = createBoss();
    const pool = database();
    try {
      await boss.start();
      console.log(JSON.stringify(await enqueueCollection(boss, pool, ['wag'], 'manual'), null, 2));
    } finally {
      await boss.stop({ graceful: false });
      await pool.end();
    }
  } else {
    const result = await collectWag(sources.find((source) => source.id === 'wag'));
    console.log(JSON.stringify(result, null, 2));
    if (result.failedPages.length) process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
