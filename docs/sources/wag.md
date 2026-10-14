# WAG–Qaumajuq events

The `wag` worker collector reads the [event calendar](https://www.wag.ca/events/event-calendar/), follows its numbered “View More” links, and reads each unique event page through a separately operated FlareSolverr service. It never fetches during a page render. Source terms review is deferred at the owner's request in issue #16.

## Local use

With the existing FlareSolverr container listening on loopback port 8191, set this in `.env.local` for the host worker:

```dotenv
WINNIGO_FLARESOLVERR_URL=http://127.0.0.1:8191
WINNIGO_WAG_PHOTO_CONTAINER=flaresolverr
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
- Printed years take precedence. When neither the calendar card nor event details provides a year, use the collection date's current year in America/Winnipeg (owner policy); retain `yearAssumed: true` in the record. Invalid or contradictory dates are withheld, and past events are skipped. Weekly classes keep `schedule: series`, so a range is not treated as daily availability.
- Multi-date landing pages are discovery-only: follow their “Choose from” WAG event links, deduplicate against calendar entries, and import the individual classes within the same 60-page budget. Related events and external links are not followed. Explicitly identified, previously saved parents are hidden from discovery, preserving their payload and owner edits for recovery. Missing or failed pages are never treated as parents to retire.
- Cards show the date range; details add the time and a select-dates reminder. Raw skipped-date/weekday/age schedule text is retained in the record but is not added to the displayed summary.
- Admission restrictions, audience, ticket links and sold-out/cancelled notices are retained. Unknown or multiple prices remain unknown. Summaries exclude related events, sponsor blocks and contact widgets. Up to three distinct WAG-hosted event photos are linked in the existing gallery, with the first used as the cover. Featured artwork and event-body photos are eligible; sponsor logos, related stories and artist-profile sections are excluded. WordPress size variants count as one photo. Saved worker runs copy original photo bytes into private content-addressed storage; dry runs only list source URLs. If an event’s photos fail, that event is withheld for retry and its previous saved version is preserved.

## Observed limitation

The live calendar advertised three pages during the October 11, 2026 check. Requests for numbered pages returned WAG's empty-results template after redirecting to `/page/2/`, even though the first page had 12 event links. The collector flags an advertised page with no new events as incomplete and saves only successfully parsed records; it does not report full coverage or cancel unseen records. Monitor this in the run history before enabling any future automation.

The November Canada Life page also printed November 15 while describing the second Sunday of November. That conflict is withheld rather than silently resolved. Raw browser output is intentionally not a test fixture: the committed fixtures are synthetic structural examples.

Two bounded local runs retrieved all 12 first-page detail pages through FlareSolverr 3.5.2. The second run produced ten listings, skipped one past event, and withheld the November date conflict. A follow-up check of the class page verified weekly scheduling and its explicit October 11 exclusion. These results verify repeat access, not complete calendar coverage or long-term reliability.

For a host worker, `WINNIGO_WAG_PHOTO_CONTAINER` names the existing FlareSolverr Docker container. The worker uses `docker exec` to download images there with the page’s temporary browser cookies and User-Agent; this requires Docker CLI access and the container’s existing Python/requests installation. No service is installed or container configuration changed. In local testing, the host received HTTP 403 even with those cookies, while downloading inside the browser container returned the original image successfully. Without the setting, downloads use the worker’s own network context. Cookies remain in memory and are never saved in listings or logs. Each image is limited to 8 MiB and 20 seconds, and all photos share the overall collection budget.

The Graphic Novel landing page links to separate classes 3 and 4. With the owner's current-year default, the October 14, 2026 collection assigns Sep 20–Nov 29, 2026 and Sep 19–Nov 28, 2026 respectively. Only the two class listings appear in discovery. Refresh WAG after restarting the updated worker to update previously saved class records and hide the parent.
