// Default is a bounded live dry run. --enqueue explicitly queues the current/next-month collection.
import { loadLocalEnv } from './load-env.mjs';
import { sources } from '../lib/connectors.mjs';
import { collectionWindow } from '../lib/event-schedule.mjs';
import {
  CLC_ID,
  collectClc,
  compareClcCalendar,
  clcCalendarRequest,
  fetchClcText,
} from '../lib/server/canada-life-centre.mjs';
loadLocalEnv();
try {
  const args = process.argv.slice(2);
  if (
    args.some((a) => !['--enqueue', '--compare'].includes(a)) ||
    (args.includes('--enqueue') && args.includes('--compare'))
  )
    throw Error('Usage: npm run collect:clc [-- --compare | --enqueue]');
  if (args.includes('--enqueue')) {
    const { readConfig } = await import('../lib/server/config.mjs');
    if (readConfig().repository !== 'postgres')
      throw Error('Queued collection requires PostgreSQL');
    const { database } = await import('../lib/server/postgres.mjs');
    const { createBoss, enqueueCollection } = await import('../lib/server/job-queue.mjs');
    const boss = createBoss(),
      pool = database();
    try {
      await boss.start();
      console.log(JSON.stringify(await enqueueCollection(boss, pool, [CLC_ID], 'manual'), null, 2));
    } finally {
      await boss.stop({ graceful: false });
      await pool.end();
    }
  } else {
    const checkedAt = new Date().toISOString(),
      window = collectionWindow(checkedAt),
      result = await collectClc(
        sources.find((s) => s.id === CLC_ID),
        checkedAt,
      );
    const comparison = args.includes('--compare')
      ? compareClcCalendar(result, await fetchClcText(clcCalendarRequest(window)))
      : undefined;
    console.log(
      JSON.stringify(
        {
          checkedAt,
          window,
          events: result.items.length,
          occurrences: result.occurrencesFound,
          discovered: result.discovered,
          failedPages: result.failedPages,
          comparison,
        },
        null,
        2,
      ),
    );
    if (
      result.failedPages.length ||
      (comparison &&
        (comparison.feedOnly.length ||
          comparison.calendarOnly.length ||
          comparison.differentEnds.length))
    )
      process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
