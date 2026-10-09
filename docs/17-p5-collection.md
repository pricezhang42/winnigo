# P5 — Collection jobs

Implemented 2026-10-08 on branch `feat/p5-collection-jobs`. The owner chose to do P5 before P4.
This step automates the existing public HTTP sources. Facebook collection is unchanged: its
existing scheduled collector keeps sending to the original site until the P6 cutover, so only one
Facebook schedule is ever active.

## How it works

- **Queue:** [pg-boss](https://github.com/timgit/pg-boss) 12.33.4 (the version tested in P0) in the
  PostgreSQL schema `winnigo_jobs` (`WINNIGO_JOBS_SCHEMA`). One queue, `collect-source`, with the
  `stately` policy keyed by source ID: at most one queued and one running job per source.
- **Schema changes:** `npm run db:migrate` applies `0005_collection_runs.sql`, installs or upgrades
  the pg-boss tables and creates or updates the queue. The web app and worker never change the
  schema at start-up.
- **Worker** ([`scripts/worker.mjs`](../scripts/worker.mjs)): processes one job at a time,
  supervises leases and runs the schedule clock. `npm run worker:check` verifies storage and the
  queue and exits.
- **Schedules** ([`lib/server/job-queue.mjs`](../lib/server/job-queue.mjs)), America/Winnipeg:
  public sources daily at 06:00; free swim at 06:00 and 15:00. They are registered only when
  `WINNIGO_SCHEDULES=enabled`; otherwise the worker removes them and runs manual refreshes only, so
  development never contacts live sites unasked. After downtime, pg-boss's `missed: 'once'` policy
  sends one catch-up job per source rather than replaying every missed slot.
- **A run** ([`lib/server/collection.mjs`](../lib/server/collection.mjs)): fetch and parse with the
  existing parsers, then save in one transaction
  ([`applySourceCollection`](../lib/server/postgres-repository.mjs)). Every collected listing is
  rewritten so its check time is current; owner overrides and hidden flags are kept. Counts:
  found, added, updated (content changed, not just the check time), unchanged, cancelled. Only
  content changes are written to `audit_records`.
- **Missing listings:** only free swim cancels sessions that disappear from its published
  schedule. Other sources keep listings they no longer show (a calendar page moving on is not a
  cancellation). Nothing is deleted.
- **Failures:** timeouts, connection errors and HTTP 429/5xx retry twice with backoff (from two
  minutes). HTTP 4xx, oversize pages and parsers that find nothing are treated as a changed source:
  no retry, the source is marked `error`, and its previous listings and last successful check time
  are kept. A job whose worker dies is recovered when its 10-minute lease expires.
- **Run records:** `collection_runs` gains `job_id`, `trigger` (schedule, manual, catch-up,
  collector), `attempts`, `started_at`, `finished_at` and a short `error`. Statuses: queued, running,
  retrying, ok, error. Retries reuse the same row.
- **Admin:** "Refresh sources" queues every public source and returns at once
  (`POST /api/sources {"action":"refresh", "source"?}`). The collection desk shows a run history
  (`GET /api/runs`, owner/admin) that updates while runs are active. Fixture mode has no queue and
  keeps the "needs PostgreSQL" response.

## Running it

```sh
npm run db:migrate          # once per update: app migrations + job tables
npm run worker              # manual refreshes only
WINNIGO_SCHEDULES=enabled npm run worker   # with the daily schedules
```

Then use **Refresh sources** on `/admin`. To enable schedules permanently, set
`WINNIGO_SCHEDULES="enabled"` in `.env.local`.

## Evidence

- `npm run check:p5` (temporary app and job schemas, fake sources, no network): queueing and
  duplicate refusal; saved listings, report and run record; unchanged re-collection not counted
  or audited and owner corrections kept; changes counted; ordinary sources keep missing listings;
  parser failures and empty pages not retried and previous listings kept; network failure retried
  on the same run, final attempt recorded; free swim cancellation; lease expiry recovery without
  duplicates; the worker loop; schedules in America/Winnipeg across the 2026 fall-back and 2027
  spring-forward changes; after three days of downtime exactly one catch-up job per source; schedule
  removal.
- Unit tests ([`p5-collection.test.mjs`](../scripts/tests/p5-collection.test.mjs)): retry
  classification, schedule coverage (never Facebook), opt-in flag, schema name validation.
- Live run on the development database through the admin refresh: all five sources collected.
  The Forks places reported 26 unchanged; free swim timed out on its first attempt, retried and
  then succeeded (291 sessions, 8 cancelled). A second free-swim refresh reported 291 unchanged,
  confirming change detection is stable on real pages.
- `check:p2`, `check:p3`, unit tests, typecheck, lint and formatting still pass.

## Step 2 — coverage and guards (2026-10-08)

None of the five sources publishes structured event data (no event JSON-LD, iCal or RSS; Travel
Manitoba's JSON-LD only describes the organisation), so the HTML parsers stay. The gap was
coverage: three sources paginate and only their first page was read.

- **Pagination** ([`collectSourcePages`](../lib/connectors.mjs)): The Forks reads this month's
  calendar plus the next two month lists; Assiniboine Park follows `?page=N` up to 5 pages and
  Travel Manitoba up to 6, continuing only while the previous page links to the next. Pages are
  read one at a time, one second apart, and merged by URL. Live result: The Forks 3 → 9 events
  (3 pages), Assiniboine Park 9 → 25 (3 pages), Travel Manitoba 18 → 77 Winnipeg events (6 pages).
- **Partial runs:** if the first page fails the run fails as before; if a later page fails, the
  listings already read are saved, the run is `partial`, nothing is cancelled and the source's
  baseline count is kept.
- **Validation** ([`invalidReason`](../lib/server/collection.mjs)): listings without a title or
  http(s) link, with impossible dates or an end before the start are rejected and counted. If every
  listing is rejected the run fails as a probable layout change.
- **Drop guard:** fewer than half of the last successful count (of at least ten) marks the run
  `warning`; for free swim it also skips cancellations, so a half-broken parse cannot cancel real
  sessions.
- **Saved-page tests** ([`source-pages.test.mjs`](../scripts/tests/source-pages.test.mjs)): trimmed
  copies of every source page in [`scripts/fixtures/pages`](../scripts/fixtures/pages) (352 KB,
  verified to parse exactly like the full pages) pin the listing counts, a sample listing, the
  Winnipeg filter, pagination discovery, month roll-over and multi-page collection with a failed
  page. A layout change shows up as a failing test when a fixture is refreshed.
- `check:p5` adds the validation, partial-run and drop-guard scenarios (12 in total).

## Event descriptions (2026-10-08)

Events from The Forks, Assiniboine Park and Travel Manitoba previously all carried the placeholder
"See … for the full program…".

- **The Forks / Assiniboine Park:** the summary already on the list page (the body paragraph without
  a class; `.event-brief`). No extra requests.
- **Travel Manitoba:** its cards have no description, so each event's own page is read: the longer
  of its schema.org Event description and meta description, marked with "…" when the site cut it
  mid-sentence. Descriptions already stored for the same URL are reused
  ([`knownDescriptions`](../lib/server/postgres-repository.mjs)), so after the first run only new
  events cost a request; at most 80 event pages per run, one second apart, only on the source's own
  site (`robots.txt` allows `/events/`). A failed event page keeps the placeholder, is counted in the
  run notes and retried next run; it never makes the run partial.
- **Text:** plain text, at most 600 characters, cut at a sentence end. Every listing links to the
  source for the full text. Owner-corrected descriptions still win.
- **Tests:** [`descriptions.test.mjs`](../scripts/tests/descriptions.test.mjs) (saved pages, reuse,
  the per-run limit, failures) and a `check:p5` scenario for passing stored descriptions.
- **Live:** all current Forks (9) and Travel Manitoba (78 event pages, 161 s) listings described;
  Assiniboine Park 25 of 25 collected listings.

## Stable event IDs (2026-10-08)

Event IDs used to combine the last URL segment with the start date a site showed. Ongoing events
(Boo at the Zoo, Gardener Chats) show a start date that moves forward, so each run created a new
listing and left stale copies behind; Assiniboine Park pages ending in `/info` could also collide.

- IDs now come from the page URL path only ([`eventListingId`](../lib/connectors.mjs)), for example
  `park-boo-at-the-zoo-info`, `forks-event-1314`. Free swim keeps its per-session IDs.
- Each run merges rows of the same source and page URL into the stable ID and **deletes** the
  copies: the owner's edits (the current ID's, else the newest copy's), access grants and audit
  history move to the survivor; dates, locations, media links and notes are rebuilt from the
  source. Copies of pages a source no longer lists collapse into their newest row. Runs report
  this as `merged`.
- The bundled snapshot uses the new IDs, and `db:seed` skips an event whose page URL is already
  stored, so seeding cannot recreate copies.
- Saved items in a browser that pointed at an old ID no longer match (accepted by the owner;
  bookmarks are per-browser until P4).
- Live cleanup on the development database: The Forks 16 listings / 16 pages, Travel Manitoba
  110 → 107, Assiniboine Park 38 → 29. The first run reports every event as updated and renamed
  rows as merged, because the ID inside each record changed.

## Rotary Club of Winnipeg (2026-10-09)

The first source added beyond the original five, collected by
[`lib/server/rotary.mjs`](../lib/server/rotary.mjs) in the worker (it is marked `workerOnly`, so
the snapshot script skips it).

1. **Upcoming Events** box on the home page: the club's public events only (member meetings are not
   listed), each with a link to its event page. The board members listed nearby are never read.
2. **Event page:** stable ID (the ClubRunner event GUID, also the calendar feed's UID), date and
   time, venue and address, description, and the small poster. The contact person is never read.
3. **Full-size poster:** large images on the home page are checked for a QR code; the code's link
   (followed only through an allowlist of hosts) must lead to a ClubRunner registration page whose
   title and written-out date match the event. Then the full poster becomes the listing image and
   the registration page adds the ticket link (shown as "Tickets & registration"), door and start
   times, and its address. An unmatched or unreadable poster is simply not attached.
- An empty box is normal between events; a missing box fails the run as a layout change. An event
  page that fails still lists the event from the box.
- Price, performers and host appear only in the poster image; the owner adds them on the admin page
  until poster reading (P6 extraction with review) exists. OCR (Tesseract) was tested and missed the
  price, so it is not used.
- Live: two events collected; the concert got the full poster, ticket link, "Doors Open 6:30 pm ·
  Concert 7:00 pm" and "603 Wellington Crescent". Tests: [`rotary.test.mjs`](../scripts/tests/rotary.test.mjs)
  with trimmed fixtures (no member names) and a crop of the poster's QR code.

## Not in this step

- Source-scoped batch import endpoint with idempotency keys for the external collector (P5 item 3)
  and an admin review queue: needed for the Facebook pipeline, planned with P6.
- Notifications for failing sources (no email channel configured yet); failures show in the admin
  run history and source cards.
- New sources: candidates need the owner's choice and a terms/robots check before adding.
