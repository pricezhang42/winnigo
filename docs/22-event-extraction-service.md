# Event extraction service

Issue #38, step 3 of Epic #33. The service accepts an already prepared **public** event context
and returns validated facts for at most one main event plus usage. Related events mentioned on
the page are outside this extraction scope. It does not fetch source URLs, save listings,
enable collection schedules, or run at app startup. The first provider is OpenAI; the service's
validation and budget logic is separate from the API adapter.

1. Validate the [prepared context](21-event-page-preparation.md) locally.
2. Ask the provider to count input tokens for the same model, instructions, text and schema
   that generation will receive. Reject an oversized input before generation.
3. Reserve the estimated full input and maximum output cost against the remaining run budget.
4. Make a structured generation request. Reconcile the reservation with reported usage.
5. Validate the returned JSON with the [shared event contract](20-event-extraction-contract.md).
   If a known end time is missing its day offset, count and reserve one correction request
   within the same deadline and budget. Return a validation failure if the correction still fails.

## Configuration

`createConfiguredEventExtractionService()` returns `null` when disabled (the default).
Set the following in a private environment only for an intentional pilot run:

| Setting | Purpose |
| --- | --- |
| `WINNIGO_EXTRACTION_PROVIDER` | `openai` to opt in; `disabled` otherwise. |
| `OPENAI_API_KEY` | API credential. Never store it in source or the extraction context. |
| `WINNIGO_EXTRACTION_MODEL` | Explicit API model ID that supports Responses Structured Outputs and input token counting. |
| `WINNIGO_EXTRACTION_MAX_INPUT_TOKENS` | Default 12,000; checked using the provider's count. |
| `WINNIGO_EXTRACTION_MAX_OUTPUT_TOKENS` | Default 4,096, including reasoning tokens. |
| `WINNIGO_EXTRACTION_TIMEOUT_MS` | Default 30,000 ms for counting and generation, including any correction. |
| `WINNIGO_EXTRACTION_RUN_BUDGET_USD` | Required positive per-instance generation budget estimate. |
| `WINNIGO_EXTRACTION_INPUT_USD_PER_MILLION` / `WINNIGO_EXTRACTION_OUTPUT_USD_PER_MILLION` | Required standard USD rates for the configured model and input size. |

Use one service instance for a whole run. Call `service.extract(context, { signal })` to invoke it,
and `service.budget()` to read the limit, amount accounted for and remaining estimate. The
operator must keep the configured rates current using [official API pricing](https://developers.openai.com/api/docs/pricing).

The ledger is in memory and resets with a new instance. It includes in-flight requests. It rounds
costs up to microdollars, charges cached input at the full input rate for the estimate, and counts
reasoning within output. When trustworthy usage is missing or a request times out after dispatch,
the full reservation stays in the ledger. This is a generation estimate, not a provider billing
limit; it does not account for separate charges, taxes, pricing changes or other processes.
The optional [PostgreSQL cache](24-event-extraction-cache.md) keeps results and usage across runs.

## Provider boundary

The adapter uses the official [Responses Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)
and [input token count endpoint](https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count).
It sends prepared context as text, with separate extraction instructions. The provider projection
omits JSON Schema metadata/unsupported string keywords and converts literals to enums. The
canonical schema still enforces all fields and sizes locally. The service returns the raw
versioned model output; consumers derive facts with `parseEventExtraction` (doc 20).

Requests use the fixed OpenAI API endpoint, reject redirects, supply no tools, request
`store: false`, and disable truncation. The caller must supply public pages only; the service
cannot identify private information from arbitrary text. Page instructions stay untrusted data.

Errors carry a stable code and safe metrics, without raw request/response text. Refusals,
incomplete outputs, invalid JSON and unsupported facts never return candidate events. There are
no automatic retries; version 2 removed the end-day-offset correction attempt.
When reported usage is incomplete, the estimate includes the retained reservation.

Tests mock the HTTP transport and verify the request contract, size limits, usage accounting,
concurrent budget reservations, timeouts, cancellation, refusals and local validation. The test suite makes no paid requests.
