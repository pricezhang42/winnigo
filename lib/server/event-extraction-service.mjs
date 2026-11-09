import { parseEventExtraction, parseExtractionContext } from '../contracts/event-extraction.mjs';

export class ExtractionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExtractionError';
    this.code = code;
  }
}

const MILLION = 1_000_000;
const resultErrors = {
  refused: 'The model refused the extraction',
  incomplete: 'The model did not finish the extraction',
  provider_failed: 'The provider could not complete the extraction',
  invalid_response: 'The provider returned an invalid response',
};
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
const positive = (n, min, max) => Number.isFinite(n) && n >= min && n <= max;

function readUsage(usage) {
  if (!integer(usage?.inputTokens, 0, MILLION) || !integer(usage?.outputTokens, 0, MILLION))
    return null;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: integer(usage.cachedInputTokens, 0, usage.inputTokens)
      ? usage.cachedInputTokens
      : null,
    reasoningTokens: integer(usage.reasoningTokens, 0, usage.outputTokens)
      ? usage.reasoningTokens
      : null,
  };
}

async function waitForProvider(work, signal) {
  signal.throwIfAborted();
  let onAbort;
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return work();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** One instance owns one run's budget. The provider must never retry generation implicitly. */
export function createEventExtractionService(
  provider,
  {
    maxInputTokens = 12_000,
    maxOutputTokens = 4_096,
    timeoutMs = 30_000,
    budgetUsd,
    inputUsdPerMillion,
    outputUsdPerMillion,
  } = {},
) {
  if (
    !provider ||
    typeof provider.countInput !== 'function' ||
    typeof provider.generate !== 'function' ||
    typeof provider.model !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(provider.model)
  )
    throw new ExtractionError('configuration', 'An extraction provider and model are required');
  if (
    !integer(maxInputTokens, 1, 131_072) ||
    !integer(maxOutputTokens, 16, 32_768) ||
    !integer(timeoutMs, 1, 120_000)
  )
    throw new ExtractionError('configuration', 'Invalid extraction token limits or timeout');
  if (
    !positive(budgetUsd, 0.000001, 10_000) ||
    !positive(inputUsdPerMillion, 0.000001, 10_000) ||
    !positive(outputUsdPerMillion, 0.000001, 10_000)
  )
    throw new ExtractionError(
      'configuration',
      'Positive extraction budget and token rates are required',
    );

  // USD per million tokens multiplied by tokens gives microdollars. Round each
  // estimate up, and reserve the whole output allowance before making a request.
  const limit = Math.floor(budgetUsd * MILLION);
  const cost = (input, output) =>
    Math.ceil(input * inputUsdPerMillion + output * outputUsdPerMillion);
  let accounted = 0;
  const budget = () => ({
    limitUsd: limit / MILLION,
    accountedUsd: accounted / MILLION,
    remainingUsd: Math.max(0, limit - accounted) / MILLION,
  });

  async function extract(value, { signal: callerSignal } = {}) {
    const started = performance.now();
    const timeout = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout.signal]) : timeout.signal;
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    let usage = null,
      inputTokens = null,
      charge = null;
    const metrics = () => ({
      model: provider.model,
      countedInputTokens: inputTokens,
      usage,
      estimatedCostUsd: charge === null ? null : charge / MILLION,
      costBasis: charge === null ? null : usage ? 'reported-usage' : 'reservation',
      durationMs: Math.round(performance.now() - started),
    });
    try {
      signal.throwIfAborted();
      let context;
      try {
        context = parseExtractionContext(value);
      } catch {
        throw new ExtractionError('invalid_context', 'The prepared context failed validation');
      }
      if (accounted >= limit)
        throw new ExtractionError('budget_exceeded', 'Extraction budget is exhausted');

      const count = await waitForProvider(() => provider.countInput(context, { signal }), signal);
      if (!integer(count, 1, MILLION))
        throw new ExtractionError(
          'invalid_response',
          'The provider returned an invalid input token count',
        );
      inputTokens = count;
      if (count > maxInputTokens)
        throw new ExtractionError(
          'input_limit',
          'The prepared context exceeds the input token limit',
        );
      signal.throwIfAborted();
      const reservation = cost(count, maxOutputTokens);
      if (reservation > limit - accounted)
        throw new ExtractionError(
          'budget_exceeded',
          'The request would exceed the remaining extraction budget',
        );
      accounted += reservation;
      charge = reservation;

      const response = await waitForProvider(
        () => provider.generate(context, { maxOutputTokens, signal }),
        signal,
      );
      usage = readUsage(response?.usage);
      if (usage) {
        charge = cost(usage.inputTokens, usage.outputTokens);
        accounted += charge - reservation;
      }
      signal.throwIfAborted();
      if (usage && (usage.inputTokens > maxInputTokens || usage.outputTokens > maxOutputTokens))
        throw new ExtractionError(
          'provider_token_limit',
          'Reported usage exceeded the configured token limit',
        );
      if (accounted > limit)
        throw new ExtractionError(
          'budget_exceeded',
          'Reported usage exceeded the extraction budget',
        );
      if (response?.status !== 'completed') {
        const code = Object.hasOwn(resultErrors, response?.status)
          ? response.status
          : 'invalid_response';
        throw new ExtractionError(code, resultErrors[code]);
      }
      try {
        return { result: parseEventExtraction(JSON.parse(response.text), context), ...metrics() };
      } catch {
        throw new ExtractionError(
          'invalid_extraction',
          'The model output failed the shared event contract',
        );
      }
    } catch (error) {
      // The request may have been billed even when its response was lost. Keep
      // the reservation when no trustworthy usage arrived, including after aborts.
      const failure = callerSignal?.aborted
        ? new ExtractionError('aborted', 'Extraction was cancelled')
        : timeout.signal.aborted
          ? new ExtractionError('timeout', 'Extraction timed out')
          : error instanceof ExtractionError
            ? error
            : new ExtractionError('provider_error', 'The extraction provider request failed');
      failure.metrics = metrics();
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }

  return { extract, budget };
}
