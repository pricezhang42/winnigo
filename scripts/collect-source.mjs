// npm run collect -- --list
// npm run collect -- <source>                     crawl only: no model, nothing stored
// npm run collect -- <source> --extract [--out f] extract every page; results go to a JSON file
//
// Step 1 of the redesign (docs/30): nothing is written to the database yet.
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
  if (!args.length) console.log('\nUsage: npm run collect -- <source> [--extract] [--out file]');
  process.exit(0);
}

const definition = findSource(args[0]);
const raw = EVENT_SOURCES.find((s) => s.id === definition.id);
const checkedAt = new Date().toISOString();
const crawl = await crawlSource(raw);
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
const result = await extractPages(raw, crawl, { extractor, checkedAt });
const out = option('--out') || `.winnigo/collect/${definition.id}-${checkedAt.slice(0, 10)}.json`;
await mkdir(dirname(out), { recursive: true });
await writeFile(
  out,
  JSON.stringify({ ...result, crawl: { failedPages: crawl.failedPages } }, null, 2),
  {
    mode: 0o600,
  },
);
const c = result.counts;
console.log(
  `${c.pages} page(s): ${c.withEvents} with ${c.events} event(s), ${c.outsideWindow} outside ` +
    `the window, ${c.none} without events, ${c.failed} failed, ${c.skipped} skipped; ` +
    `${c.supportingUsed} supporting page(s); US$${c.estimatedCostUsd}`,
);
console.log(`Written to ${out}`);
