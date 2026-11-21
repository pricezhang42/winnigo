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
to what the app fetches. It is a generalization of PR #68's `AI_SOURCES`.

| Field | Meaning |
| --- | --- |
| `id`, `name`, `notes` | Slug, label and free-form notes for the owner |
| `status` | `active`, `paused`, or `blocked` (the site refuses automated requests; no workarounds) |
| `schedule` | `daily`, `weekly` or `manual`; registered only with `WINNIGO_SCHEDULES=enabled` |
| `defaultVenue` | Venue used when a page omits it |
| `fetch.method` | `pages` (a list links to one page per event), `single-page` (one page lists many events), `browser` (pages built with JavaScript, fetched with a headless browser) |
| `fetch.allowedOrigin`, `startUrls` | The only https origin fetched, and the list pages to start from |
| `fetch.eventLinkPattern`, `nextLinkPattern` | Anchored patterns for event links and "next page" links |
| `fetch.selector`, `exclude` | Content region sent to the model |
| `fetch.maxListPages`, `maxEventPages` | Limits |
| `followOrganizer` | For listing sites: `{ when, allowedOrigins, eventPathPatterns, selectors }`. Organizer event pages on approved origins are fetched as supporting documents. |

The `sources` table holds only runtime state (last run, last error).

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
- When a source follows organizer pages, the organizer's dates and times win over the listing
  site's. A listing range that starts on the day it was read is treated as a rolled-forward
  start, not a conflict.
- Values the model cannot quote stay empty. Events with unresolved conflicts still publish, with
  the uncertainty shown, and are marked for review.
- An event that disappears from its source page is marked `gone` (hidden from discovery), never
  deleted.

## Review list

The admin screen lists every published change with its kind (`new`, `changed`, `gone`), a field
and session diff, and the page quote for each value. For each change the owner can mark it
reviewed, revert it, or edit the event. Edits are stored as owner edits and survive later runs.

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
   `single-page` fetchers; organizer following; the `events[]` contract and the organizer rule.
   Folds in PR #68.
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
