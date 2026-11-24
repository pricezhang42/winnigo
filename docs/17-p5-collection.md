# P5 — Collection jobs

Implemented 2026-10-08 on branch `feat/p5-collection-jobs`. The owner chose to do P5 before P4.
This step automates the existing public HTTP sources. Facebook collection is unchanged: its
existing scheduled collector keeps sending to the original site until the P6 cutover, so only one
Facebook schedule is ever active.

## How it works

- **Queue:** [pg-boss](https://github.com/timgit/pg-boss) 12.33.4 (the version tested in P0) in the
  PostgreSQL schema `winnigo_jobs` (`WINNIGO_JOBS_SCHEMA`). One queue, `collect-source`, with the
  `stately` policy keyed by source ID: at most one queued and one running job per source.
- **Schema changes:** `npm run db:migrate` applies the schema baseline, installs or upgrades
  the pg-boss tables and creates or updates the queue. The web app and worker never change the
  schema at start-up.
- **Worker** ([`scripts/worker.mjs`](../scripts/worker.mjs)): processes one job at a time,
  supervises leases and runs the schedule clock. `npm run worker:check` verifies storage and the
  queue and exits.
- **Schedules** ([`lib/server/job-queue.mjs`](../lib/server/job-queue.mjs)), America/Winnipeg:
  each active source's `schedule` in the source list (`config/sources.mjs`; places in
  `lib/connectors.mjs`). Currently The Forks, Assiniboine Park, Travel Manitoba and The Forks
  places daily at 06:00; free swim at 06:00 and 15:00. They are registered only when
  `WINNIGO_SCHEDULES=enabled`; otherwise the worker removes them and runs manual refreshes only, so
  development never contacts live sites unasked. After downtime, pg-boss's `missed: 'once'` policy
  sends one catch-up job per source rather than replaying every missed slot.
- **A run** ([`lib/server/collection.mjs`](../lib/server/collection.mjs)): an event source is
  crawled, extracted and published for review ([18 — Event collection](18-event-collection.md));
  unchanged pages reuse their stored extraction. The Forks places page is parsed and saved in one
  transaction ([`applySourceCollection`](../lib/server/postgres-repository.mjs)), keeping owner
  overrides and hidden flags; only content changes are written to `audit_records`.
- **Failures:** timeouts, connection errors and HTTP 429/5xx before anything was read retry twice
  with backoff (from two minutes). Anything else (HTTP 4xx, a changed page, missing extraction
  settings) is not retried: the source is marked `error` and keeps what it had. Event jobs get a
  one-hour lease; others ten minutes, after which a job whose worker died is picked up again.
- **Run records:** `collection_runs` gains `job_id`, `trigger` (schedule, manual, catch-up,
  collector), `attempts`, `started_at`, `finished_at` and a short `error`. Statuses: queued, running,
  retrying, ok, error. Retries reuse the same row.
- **Admin:** "Refresh sources" queues every active source that has a schedule and returns at once
  (`POST /api/sources {"action":"refresh", "source"?}`; paused and blocked sources are refused).
  The collection desk shows a run history (`GET /api/runs`, owner/admin) that updates while runs
  are active.

## Running it

```sh
npm run db:migrate          # once per update: app migrations + job tables
npm run worker              # manual refreshes only
WINNIGO_SCHEDULES=enabled npm run worker   # with the daily schedules
```

Then use **Refresh sources** on `/admin`. To enable schedules permanently, set
`WINNIGO_SCHEDULES="enabled"` in `.env.local`.

## Evidence

- `npm run check:p5` (temporary app and job schemas; stubbed sites and model, no network): queueing,
  duplicate refusal and refusal of blocked or paused sources; an event run publishing extracted
  events with its run record and report; unchanged pages reused without a model call; places saved
  with owner corrections kept; layout changes not retried; network failures retried on the same run
  with the final attempt recorded; lease expiry recovery without duplicates; the worker loop;
  schedules in America/Winnipeg across the 2026 fall-back and 2027 spring-forward changes; one
  catch-up job per source after downtime; schedule removal.
- Unit tests ([`p5-collection.test.mjs`](../scripts/tests/p5-collection.test.mjs)): retry
  classification, schedules naming only collectable sources (never Facebook or blocked sites),
  opt-in flag, schema name validation.
- 2026-11-23, separate local database: the admin refresh API queued The Forks and its places page;
  the worker reused both event pages (7 events unchanged, no model cost) and added 27 places.

The parser-era evidence (coverage guards, event descriptions, stable IDs, Rotary, WAG and Museum
collection) is in the git history before 2026-11-23.
