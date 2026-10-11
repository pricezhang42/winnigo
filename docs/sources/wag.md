# WAG–Qaumajuq events

The `wag` worker collector reads the [event calendar](https://www.wag.ca/events/event-calendar/), follows its numbered “View More” links, and reads each unique event page through a separately operated FlareSolverr service. It never fetches during a page render. Source terms review is deferred at the owner's request in issue #16.

## Local use

With the existing FlareSolverr container listening on loopback port 8191, set this in `.env.local` for the host worker:

```dotenv
WINNIGO_FLARESOLVERR_URL=http://127.0.0.1:8191
```

The value must be an HTTP(S) origin, without credentials or a path. A worker running in Docker needs a reachable service hostname on its private network; `127.0.0.1` inside a container refers to that container. FlareSolverr is not bundled into the production Compose stack.

Run a dry run:

```sh
npm run collect:wag
```

This prints extracted listings and counts without importing them. Exit codes: 0 = complete, 2 = partial, 1 = failed. Do not commit collected output. No browser cookies or raw responses are retained by the collector.

To save results to the configured local PostgreSQL database, start `npm run worker`, then run `npm run collect:wag -- --enqueue`. This creates the source row on first use. Subsequent runs can also use the WAG row’s Refresh action in the owner Sources panel. WAG is excluded from Refresh all and has no recurring schedule, even when other source schedules are enabled. A missing FlareSolverr URL produces an actionable failed run and preserves previous records.

## Collection behavior

- Serial requests, one-second spacing, 60-second FlareSolverr request timeout, 450-second overall budget, up to five calendar pages and 60 event pages. HTTP 429/5xx and connection failures on the first page use the existing bounded queue retries. Later failures produce a partial run.
- Only WAG calendar and event URLs are allowed. Challenge pages, unsuccessful responses, changed markup, oversized responses, and unexpected event redirects fail validation.
- Canonical event URLs provide stable IDs. Owner edits and hidden states survive repeated collection. Missing events are never inferred to be cancelled.
- Printed years and date ranges are retained; the current year is never guessed. Conflicting dates are withheld for review. Events already ended in Winnipeg time are skipped. Undated pages explicitly describing multiple class options remain activities linking to the source; individual occurrences are not invented.
- Admission restrictions, audience, ticket links and sold-out/cancelled notices are retained. Unknown or multiple prices remain unknown. Summaries exclude related events, sponsor blocks and contact widgets. Images are not collected.

## Observed limitation

The live calendar advertised three pages during the October 11, 2026 check. Requests for numbered pages returned WAG's empty-results template after redirecting to `/page/2/`, even though the first page had 12 event links. The collector flags an advertised page with no new events as incomplete and saves only successfully parsed records; it does not report full coverage or cancel unseen records. Monitor this in the run history before enabling any future automation.

The November Canada Life page also printed November 15 while describing the second Sunday of November. That conflict is withheld rather than silently resolved. Raw browser output is intentionally not a test fixture: the committed fixtures are synthetic structural examples.
