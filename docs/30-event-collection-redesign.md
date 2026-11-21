# Event collection redesign

Plan agreed on 2026-11-21. Hand-written event parsers are replaced by one AI extraction pipeline
driven by a checked-in source list. Changes publish right away and the owner reviews the diffs
afterwards. The event tables are rebuilt from a fresh baseline, and code that only existed for
the parsers, the parser comparison or the legacy import is removed.

## Decisions

| Question | Decision |
| --- | --- |
| Scope | Events only. Trails, places and Facebook community highlights keep their current collectors and `listings`. |
| Schema | Reset to a fresh migration baseline. The Node database has no production data. |
| Legacy import | Dropped. The Node site starts fresh; `event_aliases` and the legacy import/export scripts go. |
| Free swim | Moves to AI extraction like every other source. |
| Review | Publish, then review: every change publishes immediately and appears in a review list with its diff, so the owner can revert or correct it. |
| File-backed fixtures | Removed. Development and tests use PostgreSQL. |

## Source list

`config/sources.mjs` holds one entry per event source, reviewed in code like any other change
to what the app fetches. `lib/server/event-sources.mjs` validates it (`npm test` checks the
checked-in list).

| Field | Meaning |
| --- | --- |
| `id`, `name`, `notes` | Slug (the existing source id), label and notes for the owner |
| `status` | `active`, `paused` (not collected; the notes say why), or `blocked` (the site refuses automated requests; never worked around) |
| `schedule` | `manual` or a cron expression in America/Winnipeg; registered only with `WINNIGO_SCHEDULES=enabled` |
| `defaultVenue` | Venue used when a page omits it |
| `fetch.method` | `pages` (a list links to one page per event), `single-page` (each list page lists several events), `browser` (pages built with JavaScript; not supported yet) |
| `fetch.allowedOrigin`, `startUrls` | The only https origin for list and event pages, and the list pages to start from. Start URLs may contain `{today}`, `{from}`, `{to}` (YYYY-MM-DD) or `{fromUnix}`, `{toUnix}` so calendar requests ask for the collection window only |
| `fetch.eventLinkPattern` | Anchored pattern (path and query) for event links, found in anchors or as absolute URLs in the page text (calendar feeds, embedded JSON) |
| `fetch.eventKeyPattern` | Optional pattern with one capture group: links with the same key are one event (for calendars that link every date) |
| `fetch.nextLinkPattern` | A "next page" link (`rel=next`, a `next` class, or a Next / › label) must match it |
| `fetch.pageLinkPattern` | Numbered pagination: every matching list link is read, up to `maxListPages` |
| `fetch.selector`, `exclude` | Content region sent to the model |
| `fetch.maxListPages`, `maxEventPages` | Limits (at most 20 and 100) |
| `supportingPages` | `{ maxPerPage, sites: [{ origin, pattern, selector? }] }`: links on an event page to fetch with it, such as the organizer's own event page or the same site's series page listing every session |
| `extraction` | Optional `maxInputTokens` / `maxOutputTokens` for sources with long pages or many events per page |

Redirects are followed only while they stay on the source's approved origins.

`npm run collect -- --list` prints the list; `npm run collect -- <id>` crawls a source without
calling the model; `--extract` also extracts every page and writes the results to
`.winnigo/collect/` (nothing is stored in the database until step 2).

## Pipeline

```
fetch (code) → prepare text → unchanged page? skip → AI extract → proposed events
            → diff with the published events → publish → review list
```

- Code fetches every page through the shared rate-limited reader; the model only reads prepared
  text and has no network access.
- A page's content hash replaces the extraction cache: an unchanged page is not sent again.
- The extraction contract returns `events[]` instead of `event | null`, so `single-page` sources
  work.
- Supporting pages are found by code on the event page (approved origin and path pattern) and
  sent as extra documents in the same request. An organizer's dates and times win over the
  listing site's. A listing range that starts on the day it was read is treated as a rolled-forward
  start, not a conflict.
- Values the model cannot quote stay empty. Events with unresolved conflicts still publish, with
  the uncertainty shown, and are marked for review.
- An event that disappears from its source page is marked `gone` (hidden from discovery), never
  deleted.

## Storage and discovery (step 2)

Migration `0012_events.sql` adds the tables below next to the existing ones; the squash into one
baseline waits for step 4, once the parser tables can go, so local databases are reset once.

`npm run collect -- <id> --publish` crawls, extracts and publishes one run:

- A page whose prepared content, model and extraction version are unchanged reuses its stored
  output (`source_pages`), so an unchanged source costs nothing.
- Events are matched to stored ones by identity (`source_key`): the source's event key, the
  event's own URL, or listing page plus title and venue. Entries for the same event on several
  pages share their sessions.
- Sessions inside the collection window are replaced; earlier sessions are kept as history.
- An event missing from a page read in full (or from a complete crawl) is marked `gone`; failed
  or skipped pages protect their events. An event whose sessions are all over is retired without
  a review entry.

Discovery projects events into the same listing document the UI already uses (one card per event
with its next session; every session in `occurrences`; owner edits applied; source images held
back until they are copied privately). A source switches over on its first publish: its parser
listings are then left out of discovery, so the two paths never show the same event twice.

## Review list

The admin page's "Collected event changes" section lists every published change with its kind
(`new`, `changed`, `gone`), the field and session differences and any model review notes. For
each change the owner (or an admin) can:

- **Looks right**: mark it checked.
- **Undo**: hide a new event; restore a changed event's previous values as owner edits and its
  previous sessions (later runs then leave those sessions alone until the owner lets collection
  update them again); keep a vanished event listed.
- **Correct details** or **Hide event**: owner edits survive later runs; typing the collected
  value back removes a correction.

The API is `/api/event-changes` (same-origin, signed-in owner or admin). `npm run check:events`
covers publishing, reuse, merging, undo, edits and the gone rules in a temporary schema.

## Tables

| Table | Purpose |
| --- | --- |
| `sources` | Runtime state per source |
| `collection_runs` | One row per run: counts, cost, error |
| `source_pages` | Source, URL, content hash, last fetch, last extraction |
| `events` | Source, source URL, title, description, venue, address, category, price text and amount, image, status, hidden, visibility, owner edits |
| `event_sessions` | Event, start/end date, start/end time, all-day, cancelled |
| `event_changes` | Run, event, kind, before/after, diff, quotes, reviewed state |

Removed: `occurrences`, `schedule_coverage`, `source_identities`, `occurrence_grants`,
`event_aliases`, `event_alias_media`, `migration_runs`, `event_extraction_cache`,
`event_extraction_usage`, `event_extraction_comparisons`, and event rows in `listings`.
Migrations `0001`–`0012` are squashed into one baseline.

## Steps

Each step is one PR.

1. **Source list and fetching.** `config/sources.mjs` and its validation; `pages` and
   `single-page` fetchers; supporting pages; the `events[]` contract (`pageKind` in the context)
   and the organizer rule. Folds in PR #68, without its review-mode table.
2. **Schema and review.** Fresh baseline migration; repository and API read path for `events`;
   review list in the admin screen; `npm run collect -- <source>`.
3. **One side-by-side run.** Every source collected by both paths once; the owner reviews the
   differences. Add the `browser` method for sources that need it.
4. **Switch over and delete.** All parsers (`tourism-winnipeg`, `museum`, `wag`, `rotary`,
   `fortwhyte`, `manitoba-music`, `canada-life-centre`, `html-events`, `tribe-calendar`, `ics`,
   `calendar-enrichment`, `tourism-duplicates`, `wag-photos`, event parsing in `connectors.mjs`,
   `free-swim`); `collect-*.mjs` and their fixtures and tests; shadow/pilot/rollout code and
   reports; `flaresolverr`; `migrate-event-schedules`; source browser checks; legacy
   import/export and `migrate-legacy`; the file-backed fixture repository; docs 18–28 merged
   into one event collection doc.
5. **Schedules.** Per-source `schedule` registers jobs, still gated by
   `WINNIGO_SCHEDULES=enabled`. Production audience and schedules are not changed. Close
   superseded issues (#18, #20, #28, #60, #67).

## Unchanged

Facebook community highlights keep their collector and scheduler until P6. Accounts, access
and the data rules in AGENTS.md (source links, uncertainty, owner edits, no invented details,
restricted data behind owner access) are unchanged.

## Risks

- Large structured schedules such as free swim may be less reliable and costlier with AI than
  with a parser; step 3 measures this before the parser is deleted.
- With no parser to compare against, the review list is the only check on model mistakes.
- Cost is about US$0.001 per changed page; skipping unchanged pages keeps daily runs to cents.
- Sites that refuse automated requests stay `blocked`.
