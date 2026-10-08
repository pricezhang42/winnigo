# Winnigo — Implementation plan

Plan created: 2026-09-21

Progress updated: 2026-10-08

Status: **P0–P3 implemented locally; P4–P8 planned. P3 live Google/SMTP activation requires provider configuration.** See [P0 acceptance evidence and known baseline defect](13-p0-baseline.md). This plan implements [11 — Target system design](11-target-system-design.md): Node.js, PostgreSQL, S3-compatible storage, user accounts/preferences, cloud collection and an AI discovery assistant. README commands now run the Node application with PostgreSQL/S3. See [P1 evidence and limits](14-p1-foundation.md) and [P2 storage evidence](15-p2-storage.md).

## Current progress — 2026-10-08

| Phase | Status | Delivered / remaining |
| --- | --- | --- |
| P0 — Baseline | Complete | Compatibility checks, representative fixtures and pinned stack. |
| P1 — Node.js foundation | Complete locally | Next.js/Node runtime, standalone startup, Docker services and preserved discovery layout. |
| P2 — PostgreSQL and S3 | Complete locally | Transactional repository, paginated discovery, private photos, restartable migration tools and safe orphan cleanup. |
| P3 — Accounts and permissions | Implemented; local acceptance passed | Invitation-only accounts, verified email/password, reset/logout/session revocation, explicit owner bootstrap, roles, source/listing grants, scoped collector credentials and request protections. Real Google/SMTP acceptance remains pending. |
| P4 — Preferences and bookmarks | Deferred by the owner; not started | PostgreSQL preferences/bookmarks, onboarding, cross-device saves, explicit browser-save import and personalized ranking. |
| P5 — Collection jobs | Step 1 implemented locally | Durable queue, schedules, retries, lease recovery, run history and admin refresh for public sources ([evidence](17-p5-collection.md)). Remaining: collector import endpoint with idempotency keys, review queue, notifications. |
| P6 — Cloud collector | Planned | Dedicated browser/extraction service and operational recovery. |
| P7 — AI assistant | Planned | Authorized retrieval, conversational discovery and evaluations. |
| P8 — Production cutover | Planned | Real-data rehearsal, hosting, backups/restore, launch decision and a single active scheduler. |

**Verification recorded:** 35 unit/regression tests, TypeScript, optimized build, P2/P3 database/storage/account integration checks, HTTP access-boundary checks, and browser coverage for accounts plus discovery/maps/galleries/admin. The retained browser reports also confirm that device bookmarks are isolated between signed-in accounts. These are results from the implementation run, not a new full test run on the progress-update date. See [P2 evidence](15-p2-storage.md) and [P3 evidence](16-p3-accounts.md).

**Still required before enabling hosted accounts:** configure SMTP and Google OAuth, verify delivery and a real Google callback, invite and verify the intended owner, then run the explicit owner-bootstrap command. Local outbox verification and Google authorization-URL tests do not establish live-provider readiness.

**Current boundaries:** password-free loopback development remains available. Saved items are currently per-account browser storage, not PostgreSQL records or cross-device sync. The Node worker has no active collection schedules. Existing production data, site audience and legacy collector destination/schedule have not been migrated or changed by this implementation.

**Repository handoff:** the implementation is recorded in local commit `bcdf423`; `origin` is configured as `https://github.com/pricezhang42/winnigo.git`. Remote publication was not verified during this documentation update.

**Next implementation step: P5 step 2** (sturdier parsers from structured data, saved-page fixtures, new sources). P4 is deferred by the owner. The earlier P4 note follows for reference.

**P4 (deferred).** Add account-owned preference/bookmark migrations and endpoints first, then onboarding/settings, explicit import of existing device saves, and preference-based ranking. Extend deletion and cross-user access tests to these new tables. Keep Google/SMTP activation tracked separately from P4 development.

## Delivery approach

Deliver small, testable changes in the order below. Keep the existing production site and daily collector operating until the replacement passes its cutover gates. Develop against isolated databases, buckets and test users. Do not change the site's audience, move production data or replace the active scheduler as a side effect of local development.

Use a single Node.js web/API app and a separate background-worker process. Preserve the React UI and useful parser code. Introduce repository, storage and model interfaces to isolate infrastructure changes; avoid maintaining two complete implementations longer than the migration requires.

The first milestone is a private, working discovery app on Node.js/PostgreSQL/S3. The second adds personal accounts and preferences. Cloud automation follows; the user-facing assistant comes after reliable search and access controls.

## Sequence and dependencies

| Work package | Depends on | Result |
| --- | --- | --- |
| P0 — Baseline and compatibility checks | None | Verified starting point, fixtures and pinned implementation choices. |
| P1 — Node.js foundation | P0 | Standard Next.js/Node application and local services. |
| P2 — PostgreSQL, S3 and discovery API | P1 | Current discovery behavior works with the new storage stack. |
| P3 — Accounts and permissions | P2 | Individual sessions and enforced content access. |
| P4 — Preferences and bookmarks | P3 | Personal settings, saved items and explainable ranking. |
| P5 — Reliable collection jobs | P2, P3 | Scheduled collection, scoped imports and durable run history. |
| P6 — Cloud browser and extraction | P5 | Cloud collection without an interactive coding-agent session. |
| P7 — AI discovery assistant | P3, P4, P5 | Permission-aware, source-grounded conversational discovery. |
| P8 — Migration rehearsal and cutover | P0–P7 | Verified independent deployment with rollback and one active collector schedule. |

P4 and P5 have separate implementation boundaries once P3 is complete; the default execution order remains sequential. This plan does not dispatch additional agents.

## P0 — Establish the baseline

- [x] Capture repository state and record current test/build results without discarding existing changes.
- [x] Exercise discovery, filters, maps, approximate markers, galleries, admin edits and source status in a real browser.
- [x] Save sanitized fixtures for calendar events, multiple swim sessions, seasonal trails, approximate locations, comments, duplicate imports, hidden items and editorial overrides. Keep private source text and credentials out of fixtures.
- [x] Define shared validation schemas for listing imports, API responses and preferences; remove reliance on duplicated implicit shapes as components are migrated.
- [x] Verify and pin compatible Node.js/Next.js, PostgreSQL driver/Drizzle and Better Auth versions. Confirm a maintained PostgreSQL-backed job library supports leases, retries and the scheduling requirements.
- [x] Choose an S3-compatible development service and test the subset of storage operations we need. Record the choice and configuration.

**Done when:** baseline browser behavior is recorded, fixture tests reproduce key data rules, and the selected libraries pass minimal Node/PostgreSQL/auth/storage compatibility checks. Do not upgrade unrelated dependencies during this step.

## P1 — Build the Node.js foundation

Completed 2026-09-23. [Acceptance evidence](14-p1-foundation.md). The P0 `_leaflet_pos` defect is fixed and rapid map filtering/navigation passes in dev and built-browser checks. The owner’s explicitly requested password-free loopback mode is preserved; Basic mode protects container/staging runs.

- [x] Replace the default Vinext/Worker runtime with standard Next.js on Node.js, preserving existing React components, Tailwind/shadcn styling and Leaflet behavior.
- [x] Separate application configuration from Cloudflare bindings; validate required environment values on startup without logging secrets.
- [x] Add Dockerfile(s), an environment template, Compose services for PostgreSQL and development object storage, health checks and explicit migration/seed commands.
- [x] Retain an owner-only development/staging gate until P3 is complete. Do not expose private data while authentication is being replaced.
- [x] Introduce repository/storage interfaces and fixture implementations so UI/runtime work can proceed before production data migration.
- [x] Separate the background-worker entry point from the web process. Add standard scripts for both, documenting which processes each command starts.
- [x] Adapt `check:assets` to the Node build. Check actual CSS/JS responses, MIME types, grid layout and completed client loading in development and the built app.

**Primary files:** `package.json`, `app/`, `components/`, `next.config.ts`, new configuration/service modules, Docker/Compose files and setup scripts. Retire `worker.ts`/`vite.config.ts` from the default path only after equivalent behavior passes tests; preserve the legacy production release for rollback.

**Done when:** a clean environment can install, initialize and run the app without Wrangler, Worker bindings, Sites tools or a cloud account. Development and built pages display the same styled UI and cannot expose restricted fixture data anonymously.

## P2 — Implement PostgreSQL and S3 storage

- [x] Add reviewed SQL migrations for sources, listings, source identities, occurrences, locations, overrides, media associations, comment notes, run history and audit records. Reserve auth-managed schema ownership for P3.
- [x] Replace the P1 fixture adapter with PostgreSQL repositories and transactional upserts, mapping the preserved legacy D1 records. Preserve stable listing IDs, hidden state and field-level editorial overrides.
- [x] Port normalization for collection labels, trail variants, free-swim restrictions and approximate map locations. Keep unknown facts unknown.
- [x] Implement paginated server-side search, filters, detail lookup and counts. Preserve source diversity without loading the entire collection into the browser.
- [x] Add the S3 adapter for private object upload/read/delete, metadata, content hashes and ordered galleries. Keep stable media IDs separate from provider URLs.
- [x] Enforce owner-only media reads until the grant model is available. Test collisions/reuse across media associations without exposing restricted content.
- [x] Build repeatable legacy export-to-PostgreSQL and R2-to-S3 migration tools with dry-run mode, ID mappings, validation reports and restart checkpoints. Use fixtures for the first rehearsal.
- [x] Add orphan-upload cleanup with a grace period; only remove objects proven unreferenced, never objects from an unfinished import.

**Done when:** existing discovery and admin correction flows work on the new storage; repeating a batch produces no duplicate records; failed imports retain prior data; schema migrations and object-copy tools can resume safely. Search, maps and galleries match the baseline.

## P3 — Add individual accounts and permissions

Implementation and local acceptance: [P3 evidence and provider limits](16-p3-accounts.md). Google authorization setup is tested; real Google sign-in and external SMTP delivery await configuration. P4 owns server preferences/bookmarks; current browser saves are scoped per account.

- [x] Integrate Better Auth with PostgreSQL, reviewed migrations and secure session cookies. Implement Google login plus verified email/password, reset, logout and session revocation using configured providers.
- [x] Create a controlled owner-to-admin bootstrap. Never grant administration to the first public signup.
- [x] Add server-side role checks and source/listing grants. Existing private Facebook content defaults to the owner alone.
- [x] Derive identity from sessions and enforce access before discovery pagination, counts, ranking and media access. Provide the authorization boundary for future AI retrieval (implemented in P7). Isolate authorization-aware caches.
- [x] Replace the shared collector secret with revocable, source-scoped service credentials, stored as hashes where applicable. Collector credentials authorize ingestion only.
- [x] Add origin/CSRF protection, input limits, login/import rate limits and secret-safe audit logs.
- [x] Implement account/session/grant deletion and define the cleanup policy for future PostgreSQL preferences/bookmarks (P4). Document device-local save behavior and audit/backup retention separately.
- [x] Keep registration/public browsing disabled in production until the launch audience is explicitly chosen.

**Done when:** browser tests cover login, verification/reset and logout; cross-user profile/bookmark access is denied; ordinary users cannot administer; collector credentials cannot read the collection or change arbitrary records; revoked grants/sessions lose access. Private records and photos do not appear in public responses, counts, seeds or caches.

## P4 — Add preferences, bookmarks and ranking

- [ ] Add preference and bookmark tables with ownership constraints and unique user/listing keys.
- [ ] Build short onboarding, editable account settings and saved-item screens. Include interests, area/travel radius, budget, indoor/outdoor preference, family options, route difficulty/distance and optional accessibility needs.
- [ ] Implement `/api/me/preferences` and idempotent bookmark endpoints. Validate hard requirements separately from soft ranking preferences.
- [ ] Offer an explicit, repeatable import of the current browser's localStorage bookmarks after login.
- [ ] Add deterministic preference-based ranking and short explanations; current query constraints take precedence over saved defaults.
- [ ] Retain All discoveries and clear/reset controls. Never silently equate an unknown accessibility fact with meeting an accessibility requirement.

**Done when:** two users retain different preferences and bookmarks across separate browsers; retrying bookmark import causes no duplicates; logging out exposes no previous user's personal state; ranking is explainable and permissions are applied first.

## P5 — Move collection into durable jobs

- [x] Implement the chosen PostgreSQL-backed queue, source schedules, job leases, heartbeats, retries/backoff, dead-letter/blocked states and per-source concurrency limits. (Public sources: failures that need a person end as `error` without retry; a sign-in `blocked` state arrives with the browser collector in P6.)
- [x] Port existing public-source parsers unchanged where possible. Remove scraping from page reads; admin refresh enqueues a job and returns a run ID.
- [ ] Implement source-scoped import/media endpoints with validation, bounded batches and idempotency keys. Publish run counts across the whole run, not just its final chunk.
- [ ] Track scanned coverage, extraction status, accepted/rejected/review counts, photo failures, last attempt and last successful collection independently. _(Last attempt, last success and found/added/updated/unchanged/cancelled counts done; extraction, review and photo counts come with the collector pipeline.)_
- [x] Retain prior listings on network/parser failure. Distinguish partial coverage from a complete source snapshot; cancellation policy remains source-specific.
- [ ] Add an admin run-history and review screen. _(Run history done; review queue pending.)_ Show source freshness and actionable failures without dumping raw private text into logs.
- [x] Implement timezone-aware scheduling and a bounded catch-up policy. Test daily 09:00 America/Winnipeg across daylight-saving changes and restarts. (Public sources use 06:00; tested across the 2026/2027 DST changes and a three-day outage. The Facebook 09:00 schedule moves with P6.)

**Done when:** worker crashes, duplicate deliveries, network failures and retries cause neither lost accepted records nor duplicate listings. Lease expiry recovers work; sign-in blocks do not trigger endless retries. Browse requests do not wait for collection.

## P6 — Run browser collection and extraction in the cloud

- [ ] Package Python, Selenium and Chrome with pinned dependencies on a dedicated collector VM, separate from the web app. Public HTTP jobs may initially share that VM.
- [ ] Configure a private persistent browser volume, non-public browser-control ports, secure operator access and source-scoped import credentials. Do not copy local cookies or bake a signed-in profile into an image.
- [ ] Have the owner sign in directly to a fresh cloud browser. Validate source access before enabling its schedule; stop and notify on challenges or access denial.
- [ ] Enforce one process per profile using a host/profile lock as well as queue leases. Test container and host restarts.
- [ ] Implement a provider-independent extraction service to replace the current interactive agent review step. Require an approved restricted-content/model policy before sending private candidates to an external model.
- [ ] Extract bounded factual summaries, real post photo URLs and useful comment paraphrases with verified links. Apply deterministic schema checks and send uncertain or contradictory changes to review.
- [ ] Treat successful scanning, completed extraction and confirmed import as separate stages. Make publication retryable without duplicate photos or listings.
- [ ] Add candidate expiration/deletion, storage quotas, run timeouts, missed-run monitoring and meaningful-change/action-required notifications.
- [ ] Rehearse collection against staging or with production publication disabled. Do not start a second production daily schedule yet.

**Done when:** cloud collection, extraction, photo/comment ingestion and review routing work without an interactive coding agent; the profile survives restart; session expiry produces an honest blocked state; no forbidden private information is sent to the model or written to logs. Browser access may still require occasional owner intervention.

## P7 — Add the AI discovery assistant

- [ ] Add the chat UI, server-side model adapter and configurable provider/model settings. Keep API keys off the client.
- [ ] Implement bounded tools for authorized discovery search, listing details and the current user's preferences. Do not expose arbitrary SQL or arbitrary web requests.
- [ ] Return listing IDs, factual fields, source links, freshness and uncertainty. Construct result cards from authorized records rather than generated URLs.
- [ ] Make explicit user queries override preferences for the current request; ask before persisting inferred preferences.
- [ ] Add rate, token, tool-call and cost limits, cancellation/timeouts, and a useful no-results/provider-error response. Ordinary search must remain available during model outages.
- [ ] Evaluate with representative Winnipeg queries, conflicting community reports, expired/cancelled events, approximate locations, unauthorized requests and prompt injection embedded in source text.
- [ ] Start without long-term transcripts or a vector database. Document any later need for embeddings and their access/deletion rules.

**Done when:** supported recommendations trace back to authorized records; restricted data cannot leak through tools, summaries or counts; uncertain facts stay qualified; preference changes require confirmation; failures do not break discovery.

## P8 — Rehearse migration, then deploy and cut over

- [ ] Select and configure production Node hosting, PostgreSQL, S3-compatible storage, TLS, secrets, OAuth callbacks and email delivery. Provision a separate staging environment.
- [ ] Rehearse export/import using an authorized copy of the actual legacy data. Reconcile counts by source/status, stable IDs, occurrence dates, overrides, hidden state, media hashes/order and source/comment links. Do not use historical summary counts as the current migration baseline.
- [ ] Test backup restoration, failed-deployment rollback, database connection limits and representative search/import load on staging.
- [ ] Re-run unit, database/storage integration, authorization and full browser checks against the production build. Verify actual CSS/module responses, hydration, map interactions and photo navigation.
- [ ] Record the intended audience and operator acceptance. Keep restricted community content owner-only unless a separate grant decision authorizes otherwise.
- [ ] At cutover, pause old writes and the old dispatcher, drain active work, copy final deltas, reconcile them, then switch application traffic and enable exactly one new scheduler.
- [ ] Monitor data freshness, imports, authentication, storage errors and AI failures after cutover. Keep the old site and storage intact during an agreed rollback window.
- [ ] If rollback is necessary, stop new writes/jobs first and reconcile post-cutover changes before redirecting traffic. Do not overwrite new user data with an old snapshot.
- [ ] Update README, AGENTS.md, docs 01–10 and HIKING-COLLECTOR.md to the implemented Node workflow. Remove obsolete commands from default instructions and clearly archive remaining legacy operations.

**Done when:** the app and collector run independently of Codex/Cloudflare-specific tools, data/access checks pass, exactly one schedule is active, and another engineer/agent can deploy and restore the system using the written runbook.

## Decisions and external prerequisites

| Needed by | Input / resource | Work that can proceed without it |
| --- | --- | --- |
| P0–P1 | Compatible package versions and development S3 service | Local compatibility checks; no production provider needed. |
| P3 staging/production | Google OAuth credentials and email service | Local auth schema, session/permission tests and test email delivery. |
| P6 | Collector VM, secure remote access, owner's direct sign-in, approved model data policy | Container packaging, fixture extraction and review workflow. |
| P7 live model testing | Model provider credentials and budget | Tool contracts, deterministic fake-provider tests and chat UI. |
| P8 | Hosting/database/storage credentials, migration access, audience and rollback-window decisions | Local implementation, migration fixtures and runbooks. |

Do not invent credentials or silently select a paid service. Record unresolved choices with the work package they block; continue independent local work where possible.

## Verification and handoff for each work package

Each implementation change should identify its work-package ID, changed behavior, migration effects, tests performed and remaining limitations. Run unit tests, typecheck and build after behavior changes, adding integration/browser checks appropriate to the change. Never claim a page works merely because its HTML returned HTTP 200.

Track progress by checking the tasks above and recording acceptance evidence. Do not mark a package complete until its gate passes. This document introduces no new scheduled task, deployment or runtime behavior.
