// Configurable AI source (npm run collect:ai -- <source-id> [--review]).
// Default: crawl only and list the event pages found (no model calls, no database writes).
// --review: extract each page and save review rows in event_extraction_comparisons, compared
// with the reference source's saved listings. Listings are never written.
import { loadLocalEnv } from './load-env.mjs';
import { AI_SOURCES, crawlAiSource, runAiReview } from '../lib/server/ai-sources.mjs';

loadLocalEnv();
try {
  const args = process.argv.slice(2);
  const id = args.find((arg) => !arg.startsWith('--'));
  const review = args.includes('--review');
  if (!id || args.some((arg) => arg.startsWith('--') && arg !== '--review'))
    throw Error(
      'Usage: npm run collect:ai -- <source-id> [--review]\nSources: ' +
        AI_SOURCES.map((s) => s.id).join(', '),
    );
  const definition = AI_SOURCES.find((source) => source.id === id);
  if (!definition) throw Error(`Unknown AI source ${id}`);
  if (!review) {
    const crawl = await crawlAiSource(definition);
    console.log(
      JSON.stringify({ ...crawl, eventPages: crawl.eventPages.map((page) => page.url) }, null, 2),
    );
    if (crawl.failedPages.length) process.exitCode = 2;
  } else {
    const { readConfig } = await import('../lib/server/config.mjs');
    if (readConfig().repository !== 'postgres') throw Error('Review mode requires PostgreSQL');
    const { database } = await import('../lib/server/postgres.mjs');
    const { PostgresRepository } = await import('../lib/server/postgres-repository.mjs');
    const { cacheEventExtraction } = await import('../lib/server/cached-event-extraction.mjs');
    const { createConfiguredEventExtractionService } =
      await import('../lib/server/openai-event-extraction.mjs');
    const service = createConfiguredEventExtractionService();
    if (!service) throw Error('Review mode requires WINNIGO_EXTRACTION_PROVIDER');
    const pool = database();
    try {
      const reference = definition.reference
        ? [
            ...(
              await new PostgresRepository(pool).knownSourceListings(definition.reference)
            ).values(),
          ]
        : [];
      const result = await runAiReview(definition, {
        pool,
        extractor: cacheEventExtraction(pool, service),
        reference,
      });
      console.log(JSON.stringify({ ...result, referenceListings: reference.length }, null, 2));
      console.log(`Review rows: npm run extraction:shadow-report -- ${id} --details`);
    } finally {
      await pool.end();
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
