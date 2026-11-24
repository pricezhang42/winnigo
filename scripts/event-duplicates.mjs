// npm run events:duplicates
// Recomputes cross-source duplicate events (#66, lib/server/event-duplicates.mjs), as every
// collection run does, and lists what is shown once plus the unverified same-title, same-day
// pairs left separate for review.
import { localDay } from '../lib/connectors.mjs';
import { markDuplicateEvents } from '../lib/server/event-duplicates.mjs';
import { database } from '../lib/server/postgres.mjs';
import { loadLocalEnv } from './load-env.mjs';

loadLocalEnv();
const pool = database();
try {
  const { duplicates, candidates } = await markDuplicateEvents(pool, localDay());
  const describe = async (ids) =>
    new Map(
      (
        await pool.query(
          `SELECT id, source, title, venue, duplicate_of FROM events WHERE id = ANY($1::text[])`,
          [ids],
        )
      ).rows.map((row) => [row.id, row]),
    );
  const merged = (
    await pool.query(
      `SELECT d.source, d.title, c.source AS shown FROM events d JOIN events c ON c.id = d.duplicate_of
        ORDER BY d.title, d.source`,
    )
  ).rows;
  console.log(`${duplicates} duplicate events are shown once:`);
  for (const row of merged) console.log(`  ${row.title} — ${row.source}, shown as ${row.shown}`);
  const events = await describe(candidates.flat());
  console.log(`\n${candidates.length} unverified pairs stay separate (check them by hand):`);
  for (const [a, b] of candidates) {
    const [x, y] = [events.get(a), events.get(b)];
    console.log(
      `  ${x.title}\n    ${x.source}: ${x.venue || '?'}\n    ${y.source}: ${y.venue || '?'}`,
    );
  }
} finally {
  await pool.end();
}
