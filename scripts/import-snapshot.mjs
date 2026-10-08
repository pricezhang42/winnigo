// Collects the public venue sources once and rewrites the bundled snapshot in lib/data/listings.json
// and sources.json. Stops if a source returns no listings.
import { readFile, writeFile } from 'node:fs/promises';
import { parseSource, collectSource, dedupe, sources } from '../lib/connectors.mjs';
import { applyPoolClosures } from '../lib/free-swim.mjs';
// Pass --from-files to review previously downloaded pages in /tmp/<source-id>.html.
const fromFiles = process.argv.includes('--from-files');
const all = [];
const reports = [];
for (const source of sources) {
  const checkedAt = new Date().toISOString();
  let items;
  if (fromFiles) {
    items = parseSource(source.id, await readFile(`/tmp/${source.id}.html`, 'utf8'), checkedAt);
    if (source.id === 'winnipeg-free-swim')
      items = applyPoolClosures(items, await readFile('/tmp/winnigo-pools.html', 'utf8'));
  } else items = await collectSource(source, checkedAt);
  if (!items.length)
    throw Error(`${source.name}: no listings found; inspect parser before replacing snapshot`);
  all.push(...items);
  reports.push({ ...source, count: items.length, checkedAt, status: 'ok' });
}
await writeFile('lib/data/listings.json', JSON.stringify(dedupe(all), null, 2));
await writeFile('lib/data/sources.json', JSON.stringify(reports, null, 2));
console.log(reports.map((s) => `${s.name}: ${s.count}`).join('\n'));
