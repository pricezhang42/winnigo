// Summarize shadow-mode extraction comparisons (npm run extraction:shadow-report).
// Usage: npm run extraction:shadow-report -- [source] [--days=14] [--details]
import { loadLocalEnv } from './load-env.mjs';
import { database } from '../lib/server/postgres.mjs';

loadLocalEnv();
const args = process.argv.slice(2);
const source = args.find((arg) => !arg.startsWith('--')) ?? null;
const days = Number(args.find((arg) => arg.startsWith('--days='))?.slice(7) || 14);
const details = args.includes('--details');
if (!Number.isInteger(days) || days < 1) throw Error('--days must be a whole number');

const pool = database();
const filter =
  'created_at >= now() - make_interval(days => $1) AND ($2::text IS NULL OR source = $2)';
try {
  const { rows } = await pool.query(
    `SELECT source, outcome, count(*)::int AS pages,
            sum(CASE WHEN cache_hit THEN 1 ELSE 0 END)::int AS hits,
            coalesce(sum(estimated_cost_usd), 0)::float AS cost
       FROM event_extraction_comparisons WHERE ${filter}
      GROUP BY source, outcome ORDER BY source, outcome`,
    [days, source],
  );
  if (!rows.length) console.log(`No shadow comparisons in the last ${days} day(s).`);
  for (const [id, outcomes] of Map.groupBy(rows, (row) => row.source)) {
    const total = outcomes.reduce((sum, row) => sum + row.pages, 0);
    const cost = outcomes.reduce((sum, row) => sum + row.cost, 0);
    const hits = outcomes.reduce((sum, row) => sum + row.hits, 0);
    console.log(
      `\n${id}: ${total} page comparison(s), ${hits} cache hit(s), US$${cost.toFixed(4)}`,
    );
    for (const row of outcomes) console.log(`  ${row.outcome.padEnd(9)} ${row.pages}`);
    const reasons = await pool.query(
      `SELECT outcome, reason, count(*)::int AS pages FROM event_extraction_comparisons
        WHERE ${filter} AND outcome <> 'agree'
        GROUP BY outcome, reason ORDER BY pages DESC LIMIT 10`,
      [days, id],
    );
    for (const row of reasons.rows)
      console.log(`    ${row.outcome}: ${row.reason ?? 'unspecified'} (${row.pages})`);
    if (!details) continue;
    // The latest comparison per page that needs a person's attention.
    const latest = await pool.query(
      `SELECT DISTINCT ON (page_url) page_url, outcome, reason, differences
         FROM event_extraction_comparisons WHERE ${filter}
        ORDER BY page_url, created_at DESC`,
      [days, id],
    );
    for (const row of latest.rows.filter((r) => r.outcome !== 'agree')) {
      console.log(`  ${row.outcome} ${row.page_url}${row.reason ? ` (${row.reason})` : ''}`);
      for (const d of row.differences)
        console.log(
          `      ${d.field}: parser ${JSON.stringify(d.parser)} | extraction ${JSON.stringify(d.extraction)}`,
        );
    }
  }
} finally {
  await pool.end();
}
