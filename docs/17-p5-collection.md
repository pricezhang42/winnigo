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

## Not in this step

- Source-scoped batch import endpoint with idempotency keys for the external collector (P5 item 3)
  and an admin review queue: needed for the Facebook pipeline, planned with P6.
- Notifications for failing sources (no email channel configured yet); failures show in the admin
  run history and source cards.
- New sources: candidates need the owner's choice and a terms/robots check before adding.
