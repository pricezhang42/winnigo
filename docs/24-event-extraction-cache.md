# Event extraction cache and usage

The pilot can wrap one configured extraction service per run with
`cacheEventExtraction(pool, service)`. The wrapper exposes the same `extract` and `budget`
methods. Each result includes `cacheHit`. Existing collectors continue using their current
parsers.

The cache key covers the source, page and linked documents, the Winnipeg collection window,
model and extraction version. The OpenAI adapter derives its version from the prompt, correction
instructions and response schema. Refreshing a timestamp within the same window does not send
unchanged content again. A new month, changed content or a different model or version gets a
fresh extraction. Cached facts are validated again before reuse.

PostgreSQL stores validated results, including cases flagged for review, in
`event_extraction_cache`. It records hits, generations and failures in
`event_extraction_usage`, with latency, estimated cost and available input, output, cached and
reasoning tokens. Per-attempt metrics preserve available token counts when usage from another
attempt is missing. Failed generations have no reusable cache entry. The usage table omits raw
requests and provider error text.

Requests for the same key share a PostgreSQL lock during extraction. Cache and usage entries
commit together. Use a bounded pilot concurrency because each extraction holds a database
connection. The existing configurable spending cap applies per service instance and includes
correction attempts. Cache hits bypass provider calls and spend no budget.

Run `npm run check:event-extraction` against a local development database to verify the wrapper
and the listing import path in an isolated schema. The check uses synthetic model responses.
