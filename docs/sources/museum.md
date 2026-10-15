# Manitoba Museum

The `manitoba-museum` source collects public month calendars with ordinary HTTP, using their schema.org Event JSON-LD. It is worker-only and manual-only, excluded from Refresh all and recurring schedules. Page reads never collect. Terms/access follow-up was skipped at the owner's explicit request in #21.

## Run locally

```sh
npm run collect:museum
```

This is a dry run, with no database imports or photo downloads. Output includes the collection window, raw occurrence count, discovered source groups, parsed listings and partial failures. Exit codes: 0 complete, 2 partial, 1 failed. Do not commit this output.

For a saved run, start the existing local worker and enqueue:

```sh
WINNIGO_SCHEDULES=disabled npm run worker
npm run collect:museum -- --enqueue
```

Both commands use the configured database. To use the separate QA database, invoke the corresponding Node scripts with `--env-file=.winnigo/p2-qa.env`. No production schedule or destination is changed by this feature.

## Grouping and dates

The collector reads the current Winnipeg month and the following month, retaining all published occurrences overlapping the first day of this month through the last day of the following month (including already-past dates in this month). Adjacent calendar-grid dates are deduplicated. It reports input occurrences separately from output groups.

The Museum event path identifies a source program: occurrence date and ordinal suffixes are removed for the stable series ID. A recurring session ID combines that source path with its normalized start instant using the shared `occurrenceListingId` helper. Different times on one date and sessions sharing a URL remain separate; equivalent timestamp spellings and calendar-grid overlap deduplicate. Titles alone never identify a group. Separate source slugs remain separate even if their display names match. Each session links to its own published source occurrence. Exhibition links use a representative occurrence, preferring an upcoming one.

Recurring programs (including DOME@HOME and First Fridays) produce one `Event` listing per occurrence, each with `schedule: event`, `recurring: true`, `seriesId`, published `startAt`/`endAt`, local `start`/`end` dates and Winnipeg display time. Cards and details mark every session “Recurring”. Confirmed exhibition runs remain one overall listing. Timestamp offsets survive the November DST transition. Cancellation applies to the specific session unless the source explicitly cancels the whole program. Date-only sessions retain date precision without invented times. A once-only event retains its published date/time. When structured calendar text explicitly identifies a one-night/day-only event, its complete calendar metadata can be used directly without crawling a booking redirect. Online programs are identified from explicit livestream/online-event wording.

Overall exhibition bounds come from explicit opening/closing/run language in the event description or matching EventSeries metadata. Paper Trail's official description gives May 1, 2026 and April 2027: its listing stores `start: 2026-05-01`, `endMonth: 2027-04`, and **no invented closing day**. The UI displays “May 1, 2026 – Apr 2027”. Month-only end dates expire after that month in both PostgreSQL and fixture discovery reads.

An exhibition without confirmed bounds stays uncertain; samples do not establish its true opening/closing date. Previously verified run bounds survive narrower or stripped future reads, and an explicit closing day can replace a month-only end on the same stable record.

Recurring sessions use the same listing and `occurrences` tables as other single events, with generic recurrence metadata retained in both. Database copy detection includes the occurrence start instant, so sharing a source URL does not merge separate sessions. Existing session overrides/hidden states survive refreshes. After a program's replacement sessions and photos parse successfully, its prior grouped summary is hidden by its exact stable ID through the shared supersession path (never by a URL shared with sessions); its payload and owner edits remain available to admins. Summary edits are not arbitrarily assigned to one child session. Failed enrichment leaves the previous summary and sessions intact. Past sessions remain stored and visible in admin; ordinary discovery follows the existing finished-event filter. No database reset or migration is required. Run a manual saved collection to replace old program summaries; this supersedes the earlier latest-occurrence display policy.

## Bounds and photos

Requests are serial with at least 20 seconds between request starts, a 20-second request timeout, a nine-minute overall budget, two month pages and at most 20 detail pages. HTML is limited to 2 MB; photos to 8 MiB. Only the Museum's own event, month-calendar and WordPress-upload URLs are accepted. At most two redirects are followed, validating each destination; event redirects must remain in the same source series. Changed/malformed data and failed later pages produce partial results; missing events are never assumed cancelled.

Saved runs copy at most three distinct event photos into private content-addressed storage. Only event artwork identified by Event JSON-LD is eligible; inline body images are excluded because they can be funder/sponsor logos. Duplicate WordPress size variants count as one photo. Previously stored photos are reused when the source URLs match, and identical images within a run share one download. A failed photo/detail import withholds that group while keeping its prior saved version. Photos and details share the run/request budgets; a large first import may be partial and require another manual run, which reuses saved photos.

The default ICS feed was not selected: the October 14–November 30, 2026 research found 12 feed records against 162 published month-calendar occurrences. Month-specific exports also failed to establish full coverage. See #18 and #21 for the research evidence. Live counts can change and are not hardcoded in regression tests; fixtures are synthetic structural examples.
