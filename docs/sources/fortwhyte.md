# FortWhyte Alive

Manual-only collection from [FortWhyte's calendar](https://www.fortwhyte.org/events/).
Reads the full current and next Winnipeg calendar months, using the shared `collectionWindow`.
The default ICS export is truncated; it is not used to claim complete month coverage.

## Approach

`lib/server/tribe-calendar.mjs` shares JSON-LD parsing, month validation and cached-offset handling
with Manitoba Museum. `lib/server/fortwhyte.mjs` supplies source URLs, grid coverage checks and
mapping to the common typed listing and occurrence tables. No separate database schema is added.

The two month pages establish dates. Their JSON-LD includes occurrences hidden behind the grid's
“more events” links. Counts are checked against published per-day grid totals, including overflow.
Adjacent-grid overlap and duplicate featured entries merge by occurrence URL and start, retaining
richer metadata. Conflicting dates/titles make collection partial. Month navigation and response
month are validated. Missing months do not imply cancellation; explicit cancelled statuses remain
cancelled. No daily exhibition availability is invented from a date span.

A canonical source event URL groups shared details; dated URLs and `/1/`, `/2/` sessions retain
separate occurrence identities and source links. Recurring events have one dated discovery card
per active occurrence. Parent and session owner edits, hidden states and earlier records survive
repeated, partial or failed reads. Unknown prices and missing end times remain unknown.

Tribe's cached JSON-LD can apply the page's current offset to winter events. The collector keeps
published Winnipeg wall times and resolves their actual DST offset. Original published values
remain on each occurrence. Explicit UTC instants are preserved. This uses the Museum's existing
logic, now in the shared adapter.

Event image/ImageObject metadata supplies photos first. When it is missing, saved collection reads
one representative event page per shared event and checks its matching Event identity before
extracting images from the main event description or featured-image area. Header, footer and
sponsor images are excluded. This finds body images such as Bison Bus Tour’s BisonSafari photo,
which is omitted from both month JSON-LD and the public event API.

Up to three unique images per shared event are downloaded, signature/size checked and stored
through the shared private-media boundary. Shared occurrences reuse the same photos. Detail-page
checks are cached for seven days, including confirmed pages without an image; failures preserve
previous photos and dates and produce partial reporting. Existing time/request limits also bound
detail enrichment; later manual refreshes can finish deferred pages. Dry runs read calendars only
and write nothing. Records with no verified photo use a source placeholder.

Requests are serial with 60-second spacing, including photos. One run is bounded to 26 requests,
28 minutes, 2 MB per calendar and 8 MB per image; each request has a 30-second timeout. Redirects
and off-source URLs are rejected. FortWhyte manual jobs have a 30-minute expiry to allow this
spacing; other sources' job limits and all schedules are unchanged. Large future photo sets may
require another manual refresh; previously stored photos are reused on subsequent runs.

## Commands

```sh
# Read-only counts, dates and coverage failures; no raw candidates or photos are stored.
npm run collect:fortwhyte

# Queue a manual refresh in an explicitly selected database.
node --env-file=.winnigo/p2-qa.env scripts/collect-fortwhyte.mjs --enqueue

# Process manual refreshes without enabling schedules.
WINNIGO_SCHEDULES=disabled node --env-file=.winnigo/p2-qa.env scripts/worker.mjs
```

This source is excluded from Refresh all and has no scheduler entry. No production destination or
schedule is changed. Terms/access review remains deferred per the owner's instruction in #20;
the existing 60-second request spacing is retained.

## Verification

Synthetic fixtures cover repeated same-day performances, overlap, cached DST offsets, cancellation,
unknown end times/prices, malformed or wrong-month data, overflow omissions, missing months,
unsafe links and photo failures/reuse. P5 integration checks shared typed rows, repeat imports,
parent/session owner edits, hidden states, partial/failure retention and the manual job expiry.

Live evidence and QA counts are recorded in issue #20 and the implementation PR. Source counts
are observations and are not hardcoded into regression expectations.

### October 26, 2026 evidence

The two public month pages contained 105 unique URL/start occurrences inside October 1–November
30, grouped into 30 shared events. Duplicate featured entries and adjacent-grid overlap were
removed; per-day advertised totals, including overflow, were covered. November 1 Bison Bus Tour
sessions retained separate 10:30 a.m. and 1:30 p.m. Winnipeg times despite cached -05:00 values.

A manual QA queue job imported those verified snapshots and their eight distinct published images
into the separate `winnigo_p2_qa` database: 30 listings, 105 typed occurrences and eight events with
photos. Photos were captured serially at 60-second intervals. A second job reported all 30 events
unchanged, fetched only the two month snapshots and performed zero photo writes. No normal local
or production listings were collected for this verification.

120 unit tests, P2/P5 integration, TypeScript and production build passed. Full Chrome regressions
passed on built and dev QA servers; focused checks confirmed dated recurring cards, loaded private
photos and no console errors. Asset and Basic access checks passed on the QA apps. QA snapshots
and browser evidence remain ignored under `.winnigo`.

### Event-body photo correction

The calendar and public event API omit Bison Bus Tour's image, but its own event description
contains `BisonSafari-1.png`. The fallback now reads that content once per shared event rather
than once per occurrence. A targeted QA enrichment updated one shared Bison Bus Tour record and
its 23 date cards while leaving the other 29 events unchanged. Images remain private. Regression
fixtures cover detail identity/scoping, cached reuse, failed refresh retention and duplicate
featured records that otherwise discard richer image metadata.

The correction passes 123 unit tests, P5 integration, typecheck/build and Bison-specific Chrome
checks on built/dev QA apps, including the October 31 card and loaded private detail image.
