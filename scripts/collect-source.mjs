// npm run collect -- --list
// npm run collect -- <source>                      crawl only: no model, nothing stored
// npm run collect -- <source> --extract [--out f]  extract every page into a JSON file
// npm run collect -- <source> --publish            extract and publish: events are stored and
//                                                  every change is listed for review (docs/30)
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EVENT_SOURCES } from '../config/sources.mjs';
import { collectEventSource, sourceExtractor } from '../lib/server/collection.mjs';
import {
  crawlSource,
  extractPages,
  findSource,
  validateSources,
} from '../lib/server/event-sources.mjs';
import { finishRun, startRun } from '../lib/server/event-store.mjs';
import { getStorage } from '../lib/server/adapters.mjs';
import { database } from '../lib/server/postgres.mjs';
import { loadLocalEnv } from './load-env.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag('--list') || !args.length) {
  for (const s of validateSources())
    console.log(
      [s.id.padEnd(20), s.status.padEnd(8), s.fetch.method.padEnd(12), s.schedule].join(' ') +
        (s.notes ? `\n${' '.repeat(21)}${s.notes}` : ''),
    );
  if (!args.length)
    console.log('\nUsage: npm run collect -- <source> [--extract [--out file] | --publish]');
  process.exit(0);
}

const definition = findSource(args[0]);
const raw = EVENT_SOURCES.find((s) => s.id === definition.id);
const publish = flag('--publish');
const checkedAt = new Date().toISOString();
let pool, runId;
if (publish) {
  loadLocalEnv();
  pool = database();
  runId = await startRun(pool, definition.id);
}

const summarize = (c) =>
  `${c.pages} page(s): ${c.withEvents} with ${c.events} event(s), ${c.outsideWindow} outside ` +
  `the window, ${c.none} without events, ${c.failed} failed, ${c.skipped} skipped; ` +
  `${c.supportingUsed} supporting page(s); ${c.reused} unchanged page(s) reused; ` +
  `US$${c.estimatedCostUsd}`;

try {
  if (publish) {
    // The same path as the worker: crawl, extract (reusing unchanged pages) and publish.
    const run = await collectEventSource(pool, raw, { runId, checkedAt, storage: getStorage() });
    for (const f of run.crawl.failedPages) console.log(`  failed ${f.url}: ${f.error}`);
    console.log(summarize(run.result.counts));
    await finishRun(pool, runId, run.status, run.counts, run.note);
    const p = run.published;
    console.log(
      `Published: ${p.new} new, ${p.changed} changed, ${p.unchanged} unchanged, ${p.gone} gone. ` +
        'Review them in the admin page.',
    );
    const ph = run.photos;
    if (ph)
      console.log(
        `Photos: ${ph.copied} copied, ${ph.reused} reused, ${ph.notPhoto} not photos, ${ph.failed} failed.`,
      );
    process.exit(0);
  }

  const crawl = await crawlSource(raw, { checkedAt });
  console.log(
    `${definition.id}: ${crawl.listPagesRead} list page(s), ${crawl.pages.length} page(s) to read` +
      (definition.fetch.method === 'pages' ? ` of ${crawl.discovered} event(s) found` : ''),
  );
  for (const f of crawl.failedPages) console.log(`  failed ${f.url}: ${f.error}`);

  if (!flag('--extract')) {
    for (const p of crawl.pages)
      console.log(
        `  ${p.url}` +
          p.supporting.map((s) => `\n    + ${s.url}${s.error ? ` (${s.error})` : ''}`).join(''),
      );
    process.exit(0);
  }

  const extractor = sourceExtractor(definition);
  if (!extractor) throw Error('Set WINNIGO_EXTRACTION_PROVIDER and its settings to extract');
  const result = await extractPages(raw, crawl, { extractor, checkedAt });
  console.log(summarize(result.counts));
  const out = option('--out') || `.winnigo/collect/${definition.id}-${checkedAt.slice(0, 10)}.json`;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(
    out,
    JSON.stringify({ ...result, crawl: { failedPages: crawl.failedPages } }, null, 2),
    { mode: 0o600 },
  );
  console.log(`Written to ${out}`);
} catch (error) {
  if (publish) await finishRun(pool, runId, 'error', {}, error.message);
  throw error;
} finally {
  await pool?.end();
}
