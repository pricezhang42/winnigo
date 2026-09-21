# 09 — File map

Annotated map of the meaningful files. Ignore `node_modules/`, `dist/`, `.next/`, `.vinext/`,
`.wrangler/`, `.sites-runtime/`, `build/`, `vendor/`, and lockfiles.

## Root docs

- [`AGENTS.md`](../AGENTS.md) — standalone working guide (start/verify, structure, data rules).
- [`README.md`](../README.md) — app setup + deploy reference.
- [`WINNIGO.md`](../WINNIGO.md) — product features, scope, limitations (authoritative intent).
- [`HIKING-COLLECTOR.md`](../HIKING-COLLECTOR.md) — Facebook collector operating manual.
- `docs/` — this documentation set.

## Standalone runtime & auth (added in `8deb589`)

| File | Purpose |
| --- | --- |
| [`worker.ts`](../worker.ts) | Cloudflare Worker entrypoint; site-wide access gate → vinext handler. |
| [`wrangler.json`](../wrangler.json) | Standalone deploy config: name, D1/R2 bindings, `WINNIGO_AUTH_MODE`, migrations dir. |
| [`lib/auth-policy.mjs`](../lib/auth-policy.mjs) | `isOwner` / `isCollector` / `mayEnter` / `authenticationRequired` (Basic vs Sites). |
| [`lib/auth.ts`](../lib/auth.ts) | `getOwner()` — server-side owner identity from request headers. |

## App routes ([`app/`](../app))

| File | Purpose |
| --- | --- |
| [`app/page.tsx`](../app/page.tsx) | `/` → renders `<Winnigo/>`. |
| [`app/layout.tsx`](../app/layout.tsx) | Root layout. |
| [`app/globals.css`](../app/globals.css) | All app styling (Tailwind v4 + custom classes). |
| [`app/admin/page.tsx`](../app/admin/page.tsx) | `/admin`, requires owner sign-in (`getOwner()`) → `<Admin/>`. |
| [`app/api/listings/route.ts`](../app/api/listings/route.ts) | Collection read (init + refresh-on-visit). |
| [`app/api/sources/route.ts`](../app/api/sources/route.ts) | Owner/collector read + all mutations. |
| [`app/api/photos/import/route.ts`](../app/api/photos/import/route.ts) | Store FB CDN photo → R2. |
| [`app/api/photos/[id]/route.ts`](../app/api/photos/[id]/route.ts) | Serve stored photo. |

(`app/chatgpt-auth.ts` — the old SIWC helper — was **removed** in favour of `lib/auth.ts`.)

## Business logic ([`lib/`](../lib))

| File | Purpose |
| --- | --- |
| [`lib/store.ts`](../lib/store.ts) | **Core.** D1 access: `initialize`, `refreshSources`, `getCollection`, `database`. |
| [`lib/connectors.mjs`](../lib/connectors.mjs) | Venue source registry + HTML parsers + `localDay`/`dedupe`/`clean`. |
| [`lib/free-swim.mjs`](../lib/free-swim.mjs) | City free-swim parser + pool-closure application. |
| [`lib/social.mjs`](../lib/social.mjs) | Community sources + `normalizeSocial` + `normalizeHikingBatch`. |
| [`lib/auth-policy.mjs`](../lib/auth-policy.mjs) / [`lib/auth.ts`](../lib/auth.ts) | Access gate + owner identity (see above). |
| [`lib/trail-locations.ts`](../lib/trail-locations.ts) | `resolveMapLocation` + `collectionLabel` (derived read-time fields). |
| [`lib/utils.ts`](../lib/utils.ts) | `cn()` classname helper. |
| [`lib/data/*.json`](../lib/data) | Seed/fallback snapshots + trail geometry (see [03](03-data-model.md)). |

## Components ([`components/`](../components))

| File | Purpose |
| --- | --- |
| [`components/winnigo.tsx`](../components/winnigo.tsx) | Public discovery UI + detail dialog + filters. |
| [`components/admin.tsx`](../components/admin.tsx) | Collection desk. |
| [`components/social-outing-form.tsx`](../components/social-outing-form.tsx) | Add-social form. |
| [`components/trail-map.tsx`](../components/trail-map.tsx) | Leaflet map + Trails Manitoba embed. |
| [`components/listing-gallery.tsx`](../components/listing-gallery.tsx) | Photo lightbox. |
| [`components/ui/`](../components/ui) | shadcn/Radix primitives (generated). |
| [`hooks/use-mobile.ts`](../hooks/use-mobile.ts) | Viewport hook. |

## Database ([`db/`](../db), [`drizzle/`](../drizzle))

| File | Purpose |
| --- | --- |
| [`db/schema.ts`](../db/schema.ts) | Drizzle table defs: `listings`, `sources`. |
| [`db/index.ts`](../db/index.ts) | `getDb()` Drizzle handle (unused by Winnigo's raw-SQL path). |
| [`drizzle/0000_greedy_mystique.sql`](../drizzle/0000_greedy_mystique.sql) | Initial migration. |
| `drizzle/meta/` | Drizzle migration metadata. |

## Scripts ([`scripts/`](../scripts))

| File | Purpose |
| --- | --- |
| [`collect-hiking-selenium.py`](../scripts/collect-hiking-selenium.py) | Selenium candidate collector (local, headless). |
| [`enrich-hiking-posts.py`](../scripts/enrich-hiking-posts.py) | Deep per-post comment/photo enrichment. |
| [`publish-social.mjs`](../scripts/publish-social.mjs) | Upload a sanitized batch + photos to `WINNIGO_ORIGIN`. |
| [`publish-config.mjs`](../scripts/publish-config.mjs) | `publishingConfig(env)` — resolves origin + auth headers for the publisher. |
| [`framework.mjs`](../scripts/framework.mjs) | dev/build wrapper around vinext's CLI (active; replaces `run-framework.mjs`). |
| [`setup.mjs`](../scripts/setup.mjs) | Generate `.dev.vars` (owner + collector secrets); run by `npm run setup`. |
| [`import-official-trails.py`](../scripts/import-official-trails.py) | Build `official-trails.json` from Trails Manitoba KML. |
| [`import-snapshot.mjs`](../scripts/import-snapshot.mjs) | Regenerate `listings.json`/`sources.json` from live sites. |
| [`install-ci.mjs`](../scripts/install-ci.mjs) / `install-ci.sh` / `pnpm-install.mjs` / `install-pnpm.sh` | Locked install helpers. |
| [`selenium-requirements.txt`](../scripts/selenium-requirements.txt) | Pinned Selenium dependency. |
| [`tests/`](../scripts/tests) | `connectors.test.mjs`, `free-swim.test.mjs`, `portability.test.mjs`, `selenium_collector_test.py`. |
| _legacy (Sites):_ `run-framework.mjs`, `execution-profile.mjs`, `sites-env.mjs`/`.sh`, `build-verified.sh` | Kept for the old ChatGPT Sites target (`build:sites`); not used by the standalone scripts. |

## Config

| File | Purpose |
| --- | --- |
| [`wrangler.json`](../wrangler.json) | **Standalone** deploy config (D1/R2 bindings, vars, migrations). |
| [`cloudflare-env.d.ts`](../cloudflare-env.d.ts) | Types for `DB`/`BUCKET` + `WINNIGO_*` env vars. |
| [`vite.config.ts`](../vite.config.ts) | Vite + Cloudflare plugin; simulates bindings locally. |
| [`.openai/hosting.json`](../.openai/hosting.json) | Legacy Sites bindings + project id (only for `build:sites`). |
| [`next.config.ts`](../next.config.ts), [`tsconfig.json`](../tsconfig.json), [`eslint.config.mjs`](../eslint.config.mjs), [`postcss.config.mjs`](../postcss.config.mjs), [`drizzle.config.ts`](../drizzle.config.ts), [`components.json`](../components.json) | Standard tooling config. |
| [`package.json`](../package.json) | Scripts + deps. |
| [`public/`](../public) | Static assets incl. `trail-map-data.json` (downloadable route data). |
| [`examples/d1/`](../examples/d1) | Starter Drizzle "notes" example — not part of Winnigo. |
