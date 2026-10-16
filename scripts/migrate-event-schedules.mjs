// Idempotent conversion using the common import pipeline, with no live source requests.
// Run db:migrate first. Default is a read-only preview; --apply converts the selected local store.
import { loadLocalEnv } from './load-env.mjs';
loadLocalEnv();
import { getRepository } from '../lib/server/adapters.mjs';
import { normalizeEvents } from '../lib/event-schedule.mjs';
const apply = process.argv.includes('--apply');
if (process.argv.slice(2).some((a) => a !== '--apply'))
  throw Error('Usage: node scripts/migrate-event-schedules.mjs [--apply]');
const repo = getRepository(),
  state = await repo.read(),
  sources = new Map();
for (const record of state.listings) {
  const item = { ...record.payload };
  // The old City parser emitted one full record per session, without its explicit program key.
  if (item.source === 'winnipeg-free-swim' && item.facilityUrl) {
    const venue = item.venue
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-$/, '');
    item.seriesId = `winnipeg-free-swim-${venue}-${item.family ? 'family' : 'youth'}`;
    item.eventUrl = item.facilityUrl;
    item.recurring = true;
  }
  const list = sources.get(item.source) || [];
  list.push(item);
  sources.set(item.source, list);
}
let events = 0,
  occurrences = 0;
for (const [source, items] of sources) {
  const normalized = normalizeEvents(items);
  events += normalized.length;
  occurrences += normalized.reduce((n, e) => n + e.occurrences.length, 0);
  if (apply && repo.applySourceCollection)
    await repo.applySourceCollection(source, items, {
      checkedAt: new Date().toISOString(),
      complete: false,
      preserveHistory: true,
    });
}
if (apply && !repo.applySourceCollection) await repo.transaction(() => null);
console.log(
  JSON.stringify({
    mode: apply ? 'applied' : 'preview',
    originalEvents: state.listings.length,
    events,
    occurrences,
    sourceCount: sources.size,
    liveRequests: 0,
  }),
);
process.exit(0);
