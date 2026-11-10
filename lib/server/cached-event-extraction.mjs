import { createHash } from 'node:crypto';
import {
  parseExtractionContext,
  parseMainEventExtraction,
} from '../contracts/event-extraction.mjs';
import { ExtractionError } from './event-extraction-service.mjs';
import { writeTransaction } from './postgres.mjs';

function extractionKey(context, model, extractionVersion) {
  // The verified Winnipeg window already identifies the month and reference year.
  const { source, pageUrl, timeZone, window, schemaVersion, documents } = context;
  return createHash('sha256')
    .update(
      JSON.stringify({
        source,
        pageUrl,
        timeZone,
        window,
        schemaVersion,
        documents,
        model,
        extractionVersion,
      }),
    )
    .digest('hex');
}

/** Opt-in cache for prepared public event contexts. Use one service instance per run. */
export function cacheEventExtraction(pool, service) {
  const { model, extractionVersion } = service;
  if (!model || !extractionVersion)
    throw Error('The extraction service must identify its model and version');

  async function extract(value, options = {}) {
    const started = performance.now();
    const ensureActive = () => {
      if (options.signal?.aborted) throw new ExtractionError('aborted', 'Extraction was cancelled');
    };
    ensureActive();
    let context;
    try {
      context = parseExtractionContext(value);
    } catch {
      throw new ExtractionError('invalid_context', 'The prepared context failed validation');
    }
    const key = extractionKey(context, model, extractionVersion);

    // Only identical work shares a lock. Cache and usage rows commit together.
    const saved = await writeTransaction(
      pool,
      async (client) => {
        ensureActive();
        const record = (outcome, metrics, errorCode = null) =>
          client.query(
            `INSERT INTO event_extraction_usage (cache_key, source, model, outcome, error_code, metrics)
           VALUES ($1, $2, $3, $4, $5, $6)`,
            [key, context.source, model, outcome, errorCode, { ...metrics, extractionVersion }],
          );
        const cached = await client.query(
          'SELECT result FROM event_extraction_cache WHERE cache_key = $1',
          [key],
        );
        ensureActive();
        if (cached.rows.length) {
          let result;
          try {
            result = parseMainEventExtraction(cached.rows[0].result, context);
          } catch {
            await client.query('DELETE FROM event_extraction_cache WHERE cache_key = $1', [key]);
          }
          if (result) {
            const metrics = {
              model,
              countedInputTokens: 0,
              usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
              attempts: [],
              estimatedCostUsd: 0,
              costBasis: null,
              durationMs: Math.round(performance.now() - started),
            };
            await record('hit', metrics);
            return { result, ...metrics, cacheHit: true };
          }
        }

        let response;
        try {
          response = await service.extract(context, options);
        } catch (error) {
          const known = error instanceof ExtractionError;
          await record(
            'error',
            known ? (error.metrics ?? {}) : {},
            known ? error.code : 'extraction_failed',
          );
          return { error };
        }
        const { result, ...metrics } = response;
        await client.query(
          'INSERT INTO event_extraction_cache (cache_key, result) VALUES ($1, $2)',
          [key, result],
        );
        await record('ok', metrics);
        return { result, ...metrics, cacheHit: false };
      },
      'winnigo-event-extraction:' + key,
    );
    if ('error' in saved) throw saved.error;
    return saved;
  }

  return { ...service, extract };
}
