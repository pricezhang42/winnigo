// npm run collect -- --list
// npm run collect -- <source>                      crawl only: no model, nothing stored
// npm run collect -- <source> --extract [--out f]  extract every page into a JSON file
// npm run collect -- <source> --publish            extract and publish: events are stored and
//                                                  every change is listed for review (docs/30)
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EVENT_SOURCES } from '../config/sources.mjs';
import { createConfiguredEventExtractionService } from '../lib/server/openai-event-extraction.mjs';
import {
  crawlSource,
  extractPages,
  findSource,
  validateSources,
} from '../lib/server/event-sources.mjs';
import {
  finishRun,
  publishCollection,
  startRun,
  storedExtractions,
} from '../lib/server/event-store.mjs';
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

try {
  const crawl = await crawlSource(raw, { checkedAt });
  console.log(
    `${definition.id}: ${crawl.listPagesRead} list page(s), ${crawl.pages.length} page(s) to read` +
      (definition.fetch.method === 'pages' ? ` of ${crawl.discovered} event(s) found` : ''),
  );
  for (const f of crawl.failedPages) console.log(`  failed ${f.url}: ${f.error}`);

  if (!flag('--extract') && !publish) {
    for (const p of crawl.pages)
      console.log(
        `  ${p.url}` +
          p.supporting.map((s) => `\n    + ${s.url}${s.error ? ` (${s.error})` : ''}`).join(''),
      );
    process.exit(0);
  }

  // Per-source token limits raise (never lower) the configured ones for this run.
  const env = { ...process.env };
  for (const [key, name] of [
    ['maxInputTokens', 'WINNIGO_EXTRACTION_MAX_INPUT_TOKENS'],
    ['maxOutputTokens', 'WINNIGO_EXTRACTION_MAX_OUTPUT_TOKENS'],
  ]) {
    const wanted = definition.extraction?.[key];
    if (wanted && !(Number(env[name]) >= wanted)) env[name] = String(wanted);
  }
  const extractor = createConfiguredEventExtractionService(env);
  if (!extractor) throw Error('Set WINNIGO_EXTRACTION_PROVIDER and its settings to extract');
  const result = await extractPages(raw, crawl, {
    extractor,
    checkedAt,
    ...(publish ? { reuse: await storedExtractions(pool, definition.id) } : {}),
  });
  const c = result.counts;
  console.log(
    `${c.pages} page(s): ${c.withEvents} with ${c.events} event(s), ${c.outsideWindow} outside ` +
      `the window, ${c.none} without events, ${c.failed} failed, ${c.skipped} skipped; ` +
      `${c.supportingUsed} supporting page(s); ${c.reused} unchanged page(s) reused; ` +
      `US$${c.estimatedCostUsd}`,
  );

  if (publish) {
    const published = await publishCollection(pool, raw, crawl, result, { runId });
    const status = c.failed || crawl.failedPages.length ? 'partial' : 'ok';
    await finishRun(pool, runId, status, { ...c, ...published });
    console.log(
      `Published: ${published.new} new, ${published.changed} changed, ` +
        `${published.unchanged} unchanged, ${published.gone} gone. Review them in the admin page.`,
    );
  } else {
    const out =
      option('--out') || `.winnigo/collect/${definition.id}-${checkedAt.slice(0, 10)}.json`;
    await mkdir(dirname(out), { recursive: true });
    await writeFile(
      out,
      JSON.stringify({ ...result, crawl: { failedPages: crawl.failedPages } }, null, 2),
      { mode: 0o600 },
    );
    console.log(`Written to ${out}`);
  }
} catch (error) {
  if (publish) await finishRun(pool, runId, 'error', {}, error.message);
  throw error;
} finally {
  await pool?.end();
}
