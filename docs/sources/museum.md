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

The collector reads the current Winnipeg month and the following month, retaining only published occurrences from today through the end of the following month. Adjacent calendar-grid dates are deduplicated. It reports input occurrences separately from output groups.

The Museum event path identifies a group: occurrence date and ordinal suffixes are removed for the stable ID. Titles alone never identify a group. Separate source slugs remain separate even if their display names match. The user-facing link points to a published representative occurrence, preferring an upcoming one.

Each exhibition or recurring program produces one listing. Exact occurrence timestamps (including timezone offsets and cancellation flags) remain supporting samples, never an assertion of daily availability. A once-only event retains its published date/time. When structured calendar text explicitly identifies a one-night/day-only event, its complete calendar metadata can be used directly without crawling a booking redirect. Online programs are identified from explicit livestream/online-event wording.

Overall exhibition bounds come from explicit opening/closing/run language in the event description or matching EventSeries metadata. Paper Trail's official description gives May 1, 2026 and April 2027: its listing stores `start: 2026-05-01`, `endMonth: 2027-04`, and **no invented closing day**. The UI displays “May 1, 2026 – Apr 2027”. Month-only end dates expire after that month in both PostgreSQL and fixture discovery reads.

When no overall bounds are published, the listing says “Recurring program · Check dates”. `observedFrom`, `observedThrough` and occurrence samples describe only the bounded calendar read; the last sampled date is never used as an exhibition's closing date. Previously verified run bounds survive narrower or stripped future reads, and an explicit closing day can replace a month-only end on the same stable record. Owner edits/hidden states are preserved by the existing repository import path.

## Bounds and photos

Requests are serial with at least 20 seconds between request starts, a 20-second request timeout, a nine-minute overall budget, two month pages and at most 20 detail pages. HTML is limited to 2 MB; photos to 8 MiB. Only the Museum's own event, month-calendar and WordPress-upload URLs are accepted. At most two redirects are followed, validating each destination; event redirects must remain in the same source series. Changed/malformed data and failed later pages produce partial results; missing events are never assumed cancelled.

Saved runs copy at most three distinct event photos into private content-addressed storage. Only event artwork identified by Event JSON-LD is eligible; inline body images are excluded because they can be funder/sponsor logos. Duplicate WordPress size variants count as one photo. Previously stored photos are reused when the source URLs match, and identical images within a run share one download. A failed photo/detail import withholds that group while keeping its prior saved version. Photos and details share the run/request budgets; a large first import may be partial and require another manual run, which reuses saved photos.

The default ICS feed was not selected: the October 14–November 30, 2026 research found 12 feed records against 162 published month-calendar occurrences. Month-specific exports also failed to establish full coverage. See #18 and #21 for the research evidence. Live counts can change and are not hardcoded in regression tests; fixtures are synthetic structural examples.
