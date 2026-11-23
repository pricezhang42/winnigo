# Event collection

How Winnigo collects events: a checked-in source list, code that fetches pages, an AI model that
reads them, and publication followed by owner review. This replaces the hand-written parsers and
docs 18–28 (event schedules, typed listings, the extraction contract, page preparation, the
extraction service, integration, cache, pilot, rollout and acceptance). Why it changed, and the
parser-versus-AI comparison that preceded the switch, are in
[30 — Event collection redesign](30-event-collection-redesign.md).

Trails, places (The Forks' places page) and Facebook community highlights are not events: they
stay in `listings` with their own collectors.

```
config/sources.mjs → crawl (code) → prepare text → unchanged page? reuse → extract (model)
  → map and check against the page → publish → review list in the admin page
```

| File | Role |
| --- | --- |
| `config/sources.mjs` | The source list |
| `lib/server/event-sources.mjs` | Source validation, crawler, city filter, extraction of every page |
| `lib/server/source-reader.mjs` | Rate-limited, size-capped HTTP reads |
| `lib/server/event-page-preparation.mjs` | HTML to the text and links the model reads |
| `lib/contracts/event-extraction.mjs` (+ `.ts` types) | Model input and output contract, quote checks |
| `lib/server/openai-event-extraction.mjs`, `event-extraction-service.mjs` | The model call, budget and limits |
| `lib/server/extracted-event-schedule.mjs`, `lib/event-schedule.mjs` | Schedule facts to sessions in Winnipeg time |
| `lib/server/event-store.mjs` | Publishing, change records, review actions, owner edits |
| `lib/server/collection.mjs` | One collection job (worker and CLI) |
| `scripts/collect-source.mjs` | `npm run collect` |

## Source list

`config/sources.mjs` holds one entry per event source and is reviewed like code, because changing
it changes what Winnigo fetches. `npm test` validates the checked-in list.

| Field | Meaning |
| --- | --- |
| `id`, `name`, `notes` | Slug, label and notes for the owner |
| `status` | `active`, `paused` (not collected; the notes say why) or `blocked` (the site refuses automated requests; never worked around) |
| `schedule` | `manual`, or a cron expression in America/Winnipeg (see Operations) |
| `defaultVenue` | Venue used when a page omits it |
| `fetch.method` | `pages` (a list links to one page per event), `single-page` (each list page lists several events), `browser` (pages built with JavaScript; not supported yet) |
| `fetch.allowedOrigin`, `startUrls` | The only https origin for list and event pages, and where to start. Start URLs may contain `{today}`, `{from}`, `{to}` (YYYY-MM-DD) or `{fromUnix}`, `{toUnix}` so a calendar request asks for the collection window only |
| `fetch.eventLinkPattern` | Anchored pattern (path and query) for event links, found in anchors or as absolute URLs in page text (calendar feeds, embedded JSON) |
| `fetch.eventKeyPattern` | One capture group: links with the same key are one event (calendars that link every date) |
| `fetch.nextLinkPattern` | A "next page" link (`rel=next`, a `next` class, or a Next / › label) must match it |
| `fetch.pageLinkPattern` | Numbered pagination: every matching list link is read, up to `maxListPages` |
| `fetch.selector`, `exclude` | The page region sent to the model |
| `fetch.maxListPages`, `maxEventPages` | Limits (at most 20 and 200) |
| `supportingPages` | `{ maxPerPage, sites: [{ origin, pattern, selector? }] }`: links on an event page fetched with it, such as the organizer's own page or the same site's series page with every session |
| `extraction` | `maxInputTokens` / `maxOutputTokens` for long pages or many events per page; they raise, never lower, the configured limits |
| `city` | `{ name, postalPrefixes }`: keep only events in that city (see below) |

## Crawling

Code does all fetching; the model has no network access. Every request goes through the source
reader: one request per second per origin, a request and time budget per run, a 2 MB cap per
response and no automatic redirects. The crawler follows redirects itself, and only while they
stay on the source's approved origins. List pages are read first, then event pages (`pages`
method) or the list pages themselves (`single-page`), each with any supporting pages it links to.
A page that fails is recorded and the crawl continues.

## Page preparation

`prepareExtractionContext` turns fetched HTML into the model input with Cheerio. It keeps the
selected region (or the first main region, `#content`, then the body), headings, list and article
boundaries, dates and hours, tables as small HTML snippets, `<time>` display text with its
`datetime` attribute (a midnight attribute on a calendar card is not a midnight performance), and
Event JSON-LD inside the selected content. Navigation, headers, footers, scripts, hidden markup,
non-ticket forms and related or sponsor sections are dropped. Link labels stay next to their URLs;
links and images are also listed in `documents[].urls`, resolved and limited to https without
credentials. Each supporting page is its own document, so an organizer's wording is never mixed
with the listing site's. Page text stays untrusted data, including any instructions in it.

The context also carries the source, page URL, `pageKind` (`event` or `listing`), the reference
time and the collection window: this month and next in Winnipeg, computed by code. No date comes
from a model guess.

## Extraction contract

Context version 2, output version 4 (`EXTRACTION_VERSION`). `lib/contracts/event-extraction.mjs`
defines strict Zod schemas; the JSON Schema sent to the provider and the TypeScript types derive
from them.

The model returns `{ events: [...] }`, at most 60. On an event page only the first event is kept;
on a listing page each event may give the `url` of its own detail page, kept only when that link
is on the page. Each event has `title` and `titleQuote`; `venue {name, address, online, quote}`;
`price {amount, text, quote}`; `availability {status, text, quote}` (available, sold-out,
unavailable or unknown; separate from cancellation); `ticketUrl`, `organizerUrl`, up to three
`imageUrls`; `schedule`; and `reviewReasons`, each `{field, reason}`. Unknown facts are `null`;
a missing price is never free.

Schedule facts: explicit `dates` (several times a day, cancellations), `recurrence` rules (daily,
weekly or monthly; Sunday = 0; ordinal weekdays such as the first Friday), the published `run`
bounds, dated weekly visiting `hours` and `exceptions` (closures or special openings). Dates may
keep month precision or a missing year; `resolveExtractionDate` applies the reference year and
marks it assumed, never rolling an impossible date forward.

`parseEventExtraction` derives everything the model does not return: the source URL, schedule
kind, end-day offsets, currency (CAD with an amount), status, and evidence attributed to the
document each quote came from. Every quote must match the documents (after NFKC and whitespace
normalization):

- A core fact (title, run, date, rule, hours, exception) that cannot be quoted is dropped and the
  event is flagged for review.
- An optional fact (venue, address, price) that cannot be quoted becomes empty, with an issue.
- Link and image URLs not in the documents are dropped.

This checks provenance, not that the model read the quote correctly; the review list covers the
rest. Size limits: 128 KiB context, 256 KiB result, 10 documents, 40,000 characters and 200 URLs
per document, 600-character quotes. A result over a limit is rejected, never clipped.

The instructions also carry the rules found in the parser comparison: an event's own date or time
field gives its start time, not a time in its description; a page with a generic heading is still
that event, named by its title field or performers; differently named entries at one venue are
separate events; every session a supporting calendar shows is listed; an organizer's dates and
times win over a listing site's, and a listing range that starts on the day it was read is not a
published start.

## Model service

`createConfiguredEventExtractionService()` returns `null` unless configured. One instance serves
a whole run: it validates the context, counts input tokens with the provider and rejects an
oversized page before generating, reserves the worst-case cost against the run budget, makes one
structured request (`store: false`, no tools, no truncation, no redirects, no automatic retries)
and reconciles the reservation with the reported usage. Errors carry a code and safe metrics,
never page or response text.

| Setting | Purpose |
| --- | --- |
| `WINNIGO_EXTRACTION_PROVIDER` | `openai`, or `disabled` (the default; event jobs then fail with a clear error) |
| `OPENAI_API_KEY` | Kept in a private environment file only |
| `WINNIGO_EXTRACTION_MODEL` | A model that supports Responses Structured Outputs and input token counting |
| `WINNIGO_EXTRACTION_MAX_INPUT_TOKENS` / `MAX_OUTPUT_TOKENS` | Defaults 12,000 and 4,096; per-source `extraction` limits raise them |
| `WINNIGO_EXTRACTION_TIMEOUT_MS` | Default 30,000 per request |
| `WINNIGO_EXTRACTION_RUN_BUDGET_USD` | Required per-run budget estimate |
| `WINNIGO_EXTRACTION_INPUT_USD_PER_MILLION` / `OUTPUT_USD_PER_MILLION` | The model's current prices; keep them up to date |

The budget is an estimate kept in memory per run, not a provider billing limit.

## Mapping and filters

`extractPages` maps each event's schedule to sessions in Winnipeg time (DST-aware, ambiguous wall
times flagged) and keeps those that touch the collection window; the rest are counted as outside
the window. A page whose content hash (prepared documents, page kind, model and extraction
version) matches its stored row reuses the stored output instead of calling the model.

With a `city` option, an event is kept when its text names the city; otherwise the page's
structured `addressLocality` decides, then the postal prefix; a ", Town, Province" address means
another town. An event whose place is not stated stays and is flagged for review. Dropped events
are counted and never reported as gone.

## Storage

| Table | Holds |
| --- | --- |
| `sources` | Each source's latest report (status, count, check times, error) |
| `collection_runs` | One row per run or queued job: trigger, attempts, counts, cost, error |
| `source_pages` | The last fetch of each page: kind, content hash, stored model output, outcome |
| `events` | One row per event: identity (`source_key`), page and event URLs, title, description, venue, address, category, price and its wording, availability, ticket and organizer links, source image URL (not shown until copied privately), status (`active`, `cancelled`, `gone`), hidden, visibility, review notes, evidence, owner edits, `sessions_locked` |
| `event_sessions` | Event, start and end date, start and end time, cancelled |
| `event_changes` | Every published change: run, event, kind (`new`, `changed`, `gone`), field and session diff, before and after, reviewed and reverted times |

The schema starts from one baseline, `migrations/postgres/0001_baseline.sql`.

## Publishing

`publishCollection` writes one run in a transaction:

- Events are matched by identity: the source's event key, the event's own URL, or the listing page
  plus title and venue. Entries for the same event on several pages share their sessions.
- Sessions inside the collection window are replaced; earlier ones stay as history. Locked
  sessions (after an owner undo) are left alone.
- An event missing from a page that was read in full, or from a complete crawl, becomes `gone`
  (hidden from discovery, never deleted). Events on failed or skipped pages are protected. An event
  whose sessions have all ended is retired without a review entry.
- Each new, changed or gone event gets an `event_changes` row, and the source report is updated.

## Discovery

Discovery reads listings and events through one query. Each event becomes one card: its next
session, every session in `occurrences`, owner edits applied. Readers other than admins see only
events with a session that has not ended. A date filter matches an event's sessions, never the
gap between them; a dated listing matches its own dates. Restricted events follow the same source
and listing grants as listings.

## Review

The admin page's "Collected event changes" section lists every published change with its kind,
the field and session differences and any review notes. The owner or an admin can:

- **Looks right**: mark it checked.
- **Undo**: hide a new event; restore a changed event's previous values as owner edits and its
  previous sessions, locked until the owner lets collection update them again; keep a gone event
  listed.
- **Correct details** or **Hide event**: owner edits survive later runs; typing the collected
  value back removes the correction. The admin listing editor saves event corrections the same way.

The API is `/api/event-changes` (same-origin, signed-in owner or admin).

## Operations

```sh
npm run collect -- --list                 # the source list
npm run collect -- <id>                   # crawl only: no model, nothing stored
npm run collect -- <id> --extract         # extract every page into .winnigo/collect/
npm run collect -- <id> --publish         # crawl, extract and publish one run
```

The worker (`npm run worker`) runs the same job for queued refreshes. "Refresh sources" in the
admin page queues every active source with a schedule; the API also accepts one source. Paused
and blocked sources are refused. Each active source's `schedule` (a cron expression in America/Winnipeg; places use the entry in
`lib/connectors.mjs`) is registered only with `WINNIGO_SCHEDULES=enabled`; `manual`, paused
and blocked sources are never scheduled, and schedules left by a source that changed are removed
when the worker starts. A unit test pins the scheduled set and times, so changing a schedule is a
reviewed change. A
network failure before anything was read is retried by the queue; any other failure records an
error and keeps what the source had.

A database built by the migrations before the baseline is refused by `npm run db:migrate`;
`npm run db:reset -- --yes` empties a local database (loopback or the Compose service only), then
migrate and seed again. `npm run db:seed` adds the official trails, and synthetic community items
with `WINNIGO_SEED_PROFILE=qa`; events come only from collection.

## Checks

- `npm test`: source-list validation, crawler, preparation, contract and service (mocked
  transport, no paid requests), schedules.
- `npm run check:events`: publishing, reuse, merging, undo, edits and the gone rules in a temporary
  schema.
- `npm run check:p5`: the queue, an event run with a stubbed site and model, reuse, places, retries,
  lease recovery, the worker loop and schedules across DST.

## Known gaps

- Pages built with JavaScript (the `browser` method) are not read yet; Royal MTC's schedules need
  corrections through the review list.
- Source images are not shown until they are copied into private storage.
- WAG refuses automated requests and stays `blocked`.
