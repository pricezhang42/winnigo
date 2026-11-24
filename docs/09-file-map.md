# 09 — File map

Annotated map of the meaningful files. Ignore `node_modules/`, `.next/`, `dist/`, `.winnigo/` and
lockfiles. The pre-P1 Cloudflare files are reference only, in [`legacy/`](../legacy/cloudflare/README.md).

## Root docs

- [`AGENTS.md`](../AGENTS.md) — working guide (start/verify, structure, data rules).
- [`README.md`](../README.md) — setup and command reference.
- [`WINNIGO.md`](../WINNIGO.md) — product features, scope and limitations.
- [`HIKING-COLLECTOR.md`](../HIKING-COLLECTOR.md) — Facebook collector operating manual.
- `docs/` — this documentation set; [32](32-deployment.md) is the production runbook.

## Runtime, access and configuration

| File | Purpose |
| --- | --- |
| [`proxy.ts`](../proxy.ts) | Access gate in front of every page and API route; security headers. |
| [`next.config.ts`](../next.config.ts) | Next.js config (standalone output). |
| [`instrumentation.ts`](../instrumentation.ts) | Validates configuration when the server starts. |
| [`lib/server/config.mjs`](../lib/server/config.mjs) | Validated server configuration (auth mode, origin, signup, browsing, indexing, storage). |
| [`lib/security-headers.mjs`](../lib/security-headers.mjs) | CSP, frame protection, HSTS (HTTPS only), robots header. |
| [`lib/auth-policy.mjs`](../lib/auth-policy.mjs) / [`lib/auth.ts`](../lib/auth.ts) | Basic/local owner checks; `getPrincipal`, `getOwner`, `getAdmin` for routes. |
| [`lib/server/accounts.mjs`](../lib/server/accounts.mjs), [`account-mail.mjs`](../lib/server/account-mail.mjs) | Better Auth accounts (session mode), invitations, verification and account email. |
| [`lib/server/principal.mjs`](../lib/server/principal.mjs), [`access.mjs`](../lib/server/access.mjs), [`users.mjs`](../lib/server/users.mjs) | Principal from a request, roles, grants, scoped collector credentials, rate limits, Users panel. |

## App routes ([`app/`](../app))

| File | Purpose |
| --- | --- |
| [`app/page.tsx`](../app/page.tsx) | `/` → discovery (`<Winnigo/>`). |
| [`app/login/`](../app/login/page.tsx), [`app/account/`](../app/account/page.tsx) | Sign-in/sign-up/reset shell and the account page. |
| [`app/admin/page.tsx`](../app/admin/page.tsx) | `/admin` collection desk, event review and Users panel (owner/admin). |
| [`app/privacy/`](../app/privacy/page.tsx), [`app/terms/`](../app/terms/page.tsx) | Legal pages. |
| [`app/not-found.tsx`](../app/not-found.tsx), [`error.tsx`](../app/error.tsx), [`global-error.tsx`](../app/global-error.tsx), [`robots.ts`](../app/robots.ts) | Branded 404/error pages; `robots.txt` follows `WINNIGO_INDEXING`. |
| [`app/api/auth/[...all]`](../app/api/auth/[...all]/route.ts) | Better Auth endpoints. |
| [`app/api/listings/`](../app/api/listings/route.ts) | Discovery reads (paginated, permission-filtered), listing detail and availability. |
| [`app/api/sources/route.ts`](../app/api/sources/route.ts) | Owner reads, editorial actions, refresh (queues jobs), collector imports. |
| [`app/api/event-changes/`](../app/api/event-changes/route.ts), [`runs/`](../app/api/runs/route.ts) | Event review list and collection run history. |
| [`app/api/photos/[id]`](../app/api/photos/[id]/route.ts), [`photos/import`](../app/api/photos/import/route.ts) | Serve private photos; collector photo import. |
| [`app/api/me/`](../app/api/me/route.ts), [`users/`](../app/api/users/route.ts) | Current account and saved items; Users panel. |
| [`app/api/health/`](../app/api/health/route.ts) | Health check. |

## Domain, storage and collection ([`lib/`](../lib))

| File | Purpose |
| --- | --- |
| [`lib/domain.ts`](../lib/domain.ts), [`lib/server/contracts.ts`](../lib/server/contracts.ts), [`services.ts`](../lib/server/services.ts), [`adapters.mjs`](../lib/server/adapters.mjs) | Listing types and the repository/photo boundaries (PostgreSQL and S3 only). |
| [`lib/server/postgres-repository.mjs`](../lib/server/postgres-repository.mjs), [`postgres.mjs`](../lib/server/postgres.mjs) | P2 repository: discovery queries, editorial changes, duplicates hidden at read time. |
| [`lib/server/s3-storage.mjs`](../lib/server/s3-storage.mjs) | Private media in S3-compatible storage. |
| [`lib/server/actions.mjs`](../lib/server/actions.mjs), [`paged-store.ts`](../lib/server/paged-store.ts) | Atomic import and editorial operations; paginated discovery for a reader. |
| [`lib/server/saved-items.mjs`](../lib/server/saved-items.mjs) | Saved items in the account. |
| [`config/sources.mjs`](../config/sources.mjs) | Event source list and schedules ([18](18-event-collection.md)). |
| [`lib/server/event-sources.mjs`](../lib/server/event-sources.mjs), [`source-reader.mjs`](../lib/server/source-reader.mjs), [`event-page-preparation.mjs`](../lib/server/event-page-preparation.mjs) | Fetcher and page preparation for extraction. |
| [`lib/server/openai-event-extraction.mjs`](../lib/server/openai-event-extraction.mjs), [`event-extraction-service.mjs`](../lib/server/event-extraction-service.mjs) | Model call, budget and token limits. |
| [`lib/server/collection.mjs`](../lib/server/collection.mjs), [`event-store.mjs`](../lib/server/event-store.mjs), [`event-photos.mjs`](../lib/server/event-photos.mjs), [`event-duplicates.mjs`](../lib/server/event-duplicates.mjs) | Collect a source, publish events, copy photos, mark cross-source duplicates. |
| [`lib/server/job-queue.mjs`](../lib/server/job-queue.mjs) | P5 jobs and schedules (pg-boss). |
| [`lib/connectors.mjs`](../lib/connectors.mjs), [`event-schedule.mjs`](../lib/event-schedule.mjs), [`time-zone.mjs`](../lib/time-zone.mjs) | Text/date helpers, The Forks places parser, sessions and Winnipeg time. |
| [`lib/social.mjs`](../lib/social.mjs) | Community sources and Facebook batch normalization. |
| [`lib/trail-locations.ts`](../lib/trail-locations.ts), [`location-resolution.mjs`](../lib/location-resolution.mjs) | Map locations and collection labels. |
| [`lib/data/`](../lib/data) | Official trails, trail map geometry and anchors, time-zone data. |

## Components ([`components/`](../components))

| File | Purpose |
| --- | --- |
| [`winnigo.tsx`](../components/winnigo.tsx) | Discovery page: filters and layout. |
| [`discovery/`](../components/discovery) | Listing card, detail dialog ("Also listed by"), feature tiles, dialogs, data and saved-item hooks. |
| [`admin.tsx`](../components/admin.tsx), [`event-review.tsx`](../components/event-review.tsx), [`users-panel.tsx`](../components/users-panel.tsx) | Collection desk, event review, Users panel. |
| [`account-login.tsx`](../components/account-login.tsx), [`account-settings.tsx`](../components/account-settings.tsx), [`legal-page.tsx`](../components/legal-page.tsx) | Sign-in shell, account page, legal page layout. |
| [`trail-map.tsx`](../components/trail-map.tsx), [`listing-gallery.tsx`](../components/listing-gallery.tsx), [`social-outing-form.tsx`](../components/social-outing-form.tsx) | Leaflet map + Trails Manitoba embed, photo lightbox, add-social form. |
| [`ui/`](../components/ui), [`hooks/use-mobile.ts`](../hooks/use-mobile.ts) | shadcn/Radix primitives (generated); viewport hook. |

## Database ([`migrations/postgres/`](../migrations/postgres))

| File | Purpose |
| --- | --- |
| [`0001_baseline.sql`](../migrations/postgres/0001_baseline.sql) | Schema baseline: listings, trails, media, sources, runs, access and grants, events and their sessions and changes. |
| [`0002_event_photos.sql`](../migrations/postgres/0002_event_photos.sql) | Private copies of event photos (`events.media_id`). |
| [`0003_saved_items.sql`](../migrations/postgres/0003_saved_items.sql) | Saved items in the account. |
| [`0004_event_duplicates.sql`](../migrations/postgres/0004_event_duplicates.sql) | `events.duplicate_of` for cross-source duplicates. |

`drizzle/` and `examples/d1/` are leftovers from the Cloudflare app and are not used.

## Scripts ([`scripts/`](../scripts))

| File | Purpose |
| --- | --- |
| [`node-app.mjs`](../scripts/node-app.mjs), [`setup.mjs`](../scripts/setup.mjs), [`load-env.mjs`](../scripts/load-env.mjs) | dev/build/start with validated config; create `.env.local`; load it for scripts. |
| [`migrate-postgres.mjs`](../scripts/migrate-postgres.mjs), [`seed-node.mjs`](../scripts/seed-node.mjs), [`reset-database.mjs`](../scripts/reset-database.mjs) | Migrations, official-trail seed, local reset. |
| [`backup-database.mjs`](../scripts/backup-database.mjs), [`restore-database.mjs`](../scripts/restore-database.mjs) | Backup to and restore from the backup bucket ([32](32-deployment.md)). |
| [`worker.mjs`](../scripts/worker.mjs), [`check-worker.mjs`](../scripts/check-worker.mjs) | Collection worker and its health check. |
| [`collect-source.mjs`](../scripts/collect-source.mjs), [`event-duplicates.mjs`](../scripts/event-duplicates.mjs) | Collect one source by hand; recompute duplicates. |
| [`manage-accounts.mjs`](../scripts/manage-accounts.mjs), [`cleanup-accounts.mjs`](../scripts/cleanup-accounts.mjs), [`check-providers.mjs`](../scripts/check-providers.mjs) | Operator account commands, unverified-account cleanup, provider checks. |
| [`cleanup-media.mjs`](../scripts/cleanup-media.mjs) | Orphan photo cleanup (dry run by default). |
| [`collect-hiking-selenium.py`](../scripts/collect-hiking-selenium.py), [`enrich-hiking-posts.py`](../scripts/enrich-hiking-posts.py), [`publish-social.mjs`](../scripts/publish-social.mjs), [`publish-config.mjs`](../scripts/publish-config.mjs) | Facebook collector: candidates, enrichment, upload to `WINNIGO_ORIGIN`. |
| [`import-official-trails.py`](../scripts/import-official-trails.py) | Build `official-trails.json` from Trails Manitoba KML. |
| `check-*.mjs`, `check-*.py`, `setup-qa.mjs`, `setup-auth-qa.mjs` | Integration, HTTP and browser checks and their QA setup. |
| [`tests/`](../scripts/tests) | Unit and regression tests (`npm test`) and the Selenium collector test. |

## Infrastructure and tooling

| File | Purpose |
| --- | --- |
| [`compose.yaml`](../compose.yaml) | Local PostgreSQL and S3-compatible storage. |
| [`compose.production.yaml`](../compose.production.yaml), [`deploy/`](../deploy) | Production stack, Caddy, `compose.sh` and the backup timer ([32](32-deployment.md)). |
| [`Dockerfile`](../Dockerfile) | Production image (standalone server, scripts and their dependencies). |
| [`.env.example`](../.env.example), [`.env.production.example`](../.env.production.example) | Safe templates; real values never committed. |
| [`tsconfig.json`](../tsconfig.json), [`eslint.config.mjs`](../eslint.config.mjs), [`postcss.config.mjs`](../postcss.config.mjs), [`components.json`](../components.json), [`ruff.toml`](../ruff.toml) | Tooling config. |
| [`public/`](../public) | Static assets including `trail-map-data.json` (downloadable route data). |
