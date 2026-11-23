# Event collection redesign

Plan agreed on 2026-11-21. Hand-written event parsers are replaced by one AI extraction pipeline
driven by a checked-in source list. Changes publish right away and the owner reviews the diffs
afterwards. The event tables are rebuilt from a fresh baseline, and code that only existed for
the parsers, the parser comparison or the legacy import is removed.

How collection works now (source list, pipeline, contract, storage, review and operations) is in
[18 — Event collection](18-event-collection.md). This document records the decisions, the
comparison that justified the switch, and the steps.

## Decisions

| Question | Decision |
| --- | --- |
| Scope | Events only. Trails, places and Facebook community highlights keep their current collectors and `listings`. |
| Schema | Reset to a fresh migration baseline. The Node database has no production data. |
| Legacy import | Dropped. The Node site starts fresh; `event_aliases` and the legacy import/export scripts go. |
| Free swim | Moves to AI extraction like every other source. |
| Review | Publish, then review: every change publishes immediately and appears in a review list with its diff, so the owner can revert or correct it. |
| File-backed fixtures | Removed. Development and tests use PostgreSQL. |

## Side-by-side comparison (step 3)

On 2026-11-21 every active source was collected once by its parser (in memory) and once by the AI
path (nothing published), and every disagreement from today to the end of next month went on a
review page for the owner's verdicts. Canada Life Centre agreed fully. The differences led to six
changes:

| Finding | Change |
| --- | --- |
| FortWhyte event pages show one date each (often an earlier one) and its series pages load sessions with JavaScript | FortWhyte is read from its list view as listing pages; links to each date of an event share its key |
| Zoo Lights and TROLLS live outside `/events/event/<n>` | Assiniboine Park's event-link pattern includes `/events/zoolights` and `/trolls` |
| 26 Manitoba Music pages have the generic heading "Manitoba Live Music Event" | A page with a generic heading but its own event details is still that event, named by its title field or performers |
| Travel Manitoba lists events across the province | Source option `city`: an event whose address, venue or event page's structured address (`addressLocality`) names another town or postal area is dropped (and never reported as gone); one whose place is not stated stays, flagged for review |
| The same page gave different answers between runs (free swim youth swims, a Museum series) | Listing entries with different names at one venue are separate events; every session a supporting calendar shows is listed |
| The model took "Show: 8:00 PM" from the description over the page's Date field (owner verdicts: the Date field is right) | An event's own date/time field gives the start time; description times do not replace it |

Tourism Winnipeg timed out under sustained crawling during the run (both paths lost most pages)
and is compared from the 2026-11-20 review instead. Pages that need JavaScript (Royal MTC's
schedules) are still unreadable; corrections go through the review list.

## Removed

Tables `occurrences`, `schedule_coverage`, `source_identities`, `occurrence_grants`,
`event_aliases`, `event_alias_media`, `migration_runs`, `event_extraction_cache`,
`event_extraction_usage` and `event_extraction_comparisons`; event rows in `listings` and the
listing columns only events used (`closing_month`, `recurring`). Migrations `0001`–`0012` became
`0001_baseline.sql`.

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
   into one event collection doc. Done on 2026-11-23: the worker and `npm run collect` share one
   collection path; The Forks' places page keeps its parser as a places source; WAG stays
   `blocked` and Rotary `paused`. Local databases are reset once with `npm run db:reset`.
5. **Schedules.** Per-source `schedule` registers jobs, still gated by
   `WINNIGO_SCHEDULES=enabled`. Production audience and schedules are not changed. Close
   superseded issues (#18, #20, #28, #60, #67).

## Unchanged

Facebook community highlights keep their collector and scheduler until P6. Accounts, access
and the data rules in AGENTS.md (source links, uncertainty, owner edits, no invented details,
restricted data behind owner access) are unchanged.

## Risks

- Large structured schedules such as free swim may be less reliable and costlier with AI than
  with a parser; step 3 measured them (17 of 17 free swim programs agreed after the fixes).
- With no parser to compare against, the review list is the only check on model mistakes.
- Cost is about US$0.001 per changed page; skipping unchanged pages keeps daily runs to cents.
- Sites that refuse automated requests stay `blocked`.
