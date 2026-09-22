# 02 — Architecture

This describes the current implementation. For the planned replacement using Node.js, PostgreSQL and S3-compatible storage, see [11 — Target system design](11-target-system-design.md).

## Stack

- **Framework:** [vinext](https://github.com/cloudflare/vinext) — Next.js App Router (Next 16,
  React 19) compiled to run on a **Cloudflare Worker** via Vite. This is *not* a normal Next.js
  Node deployment; server code runs in the Workers runtime.
- **Runtime imports:** server modules import `{ env } from 'cloudflare:workers'` to reach bindings.
- **Database:** Cloudflare **D1** (SQLite), accessed with raw prepared statements and, in the
  example surface, Drizzle ORM.
- **Object storage:** Cloudflare **R2** for private post photos.
- **UI:** React client components, Tailwind CSS v4, shadcn/Radix UI primitives in
  [`components/ui/`](../components/ui), Leaflet for the trail map.
- **Collector:** Python + Selenium (isolated venv), run locally, out-of-band from the Worker.
- **Deploy:** standalone Cloudflare Worker via [`wrangler.json`](../wrangler.json) + [`worker.ts`](../worker.ts)
  (`npm run deploy`). No ChatGPT Sites platform involved. See [07 — Development](07-development.md).

## Bindings & config

Standalone bindings/vars are declared in [`wrangler.json`](../wrangler.json):

```json
{ "name": "winnigo", "main": "worker.ts",
  "vars": { "WINNIGO_AUTH_MODE": "basic" },
  "d1_databases": [{ "binding": "DB", ... }],
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "winnigo-photos" }] }
```

- `DB` → D1 database (listings + sources). Read from `env.DB`.
- `BUCKET` → R2 bucket for photos under the `photos/<sha256>` key space.
- `WINNIGO_AUTH_MODE` → `basic` (standalone, HTTP Basic owner auth) or `sites` (legacy SIWC).
- `WINNIGO_ADMIN_USER` / `WINNIGO_ADMIN_PASSWORD` → owner Basic-auth credentials (secrets; local
  values generated into `.dev.vars` by `npm run setup`).
- `WINNIGO_COLLECTOR_KEY` → secret that authorizes only the Facebook group-sync action and photo
  import (never reads or general admin). See [08 — Security & privacy](08-security-privacy.md).
- Types for the optional bindings live in [`cloudflare-env.d.ts`](../cloudflare-env.d.ts); update it
  if binding names change.

[`.openai/hosting.json`](../.openai/hosting.json) (`{ d1, r2, project_id }`) is retained only for the
legacy Sites target (`npm run build:sites`). `vite.config.ts` simulates the bindings for local dev;
local D1/R2 state persists under `.wrangler/state` (git-ignored).

## Routes

App Router routes under [`app/`](../app):

| Path | File | Purpose |
| --- | --- | --- |
| `/` | [`app/page.tsx`](../app/page.tsx) → [`components/winnigo.tsx`](../components/winnigo.tsx) | Public discovery UI. |
| `/admin` | [`app/admin/page.tsx`](../app/admin/page.tsx) → [`components/admin.tsx`](../components/admin.tsx) | Owner-only collection desk. Requires owner sign-in (Basic auth). |
| `GET /api/listings` | [`app/api/listings/route.ts`](../app/api/listings/route.ts) | Public collection read; triggers init + refresh-on-visit. |
| `GET/POST /api/sources` | [`app/api/sources/route.ts`](../app/api/sources/route.ts) | Owner/collector read + all mutations (refresh, add-social, update, sync-hiking-manitoba). |
| `POST /api/photos/import` | [`app/api/photos/import/route.ts`](../app/api/photos/import/route.ts) | Store a Facebook CDN photo into R2; returns `/api/photos/<hash>`. |
| `GET /api/photos/[id]` | [`app/api/photos/[id]/route.ts`](../app/api/photos/[id]/route.ts) | Serve a stored photo (private cache) by 64-hex id. |

The **whole site** sits behind an access gate in [`worker.ts`](../worker.ts): `mayEnter()`
([`lib/auth-policy.mjs`](../lib/auth-policy.mjs)) returns 401 (`WWW-Authenticate: Basic`) to anyone
who isn't the owner, except collector POSTs to `/api/sources` and `/api/photos/import`. In legacy
`sites` mode this gate is a no-op (the Sites dispatch enforces the audience instead). See
[08 — Security & privacy](08-security-privacy.md).

All API routes set `export const dynamic = 'force-dynamic'` because they depend on per-request
identity/auth headers and live storage.

## Request lifecycle — public read

`GET /api/listings` ([`route.ts:5`](../app/api/listings/route.ts)):

1. `initialize()` — idempotently seed D1 from JSON snapshots (social seeds, listing seeds, source
   reports, and the official-trails import). Seeds use `INSERT OR IGNORE` / upsert-preserving so
   they never clobber owner corrections.
2. `refreshSources()` — for each venue source whose last attempt is > 6 h old, take a per-source
   lock (a conditional `UPDATE ... attempted_at`), fetch + parse, upsert listings, mark ok/error.
3. `getCollection()` — read all listings + source reports, apply overrides & hidden state, filter
   out hidden/cancelled/past, dedupe, sort, and **interleave sources** for a varied feed.
4. On any failure the route falls back to the committed JSON snapshot with a "last collected" notice.

The heavy lifting lives in [`lib/store.ts`](../lib/store.ts). See
[04 — Sources & connectors](04-sources-and-connectors.md).

## Request lifecycle — mutations

`POST /api/sources` handles four actions, gated by auth (owner Basic-auth session **or** the
collector key for the sync action only):

- `refresh` → force `refreshSources(true)`.
- `add-social` → validate + insert one manual Facebook/Instagram outing.
- `update` → patch title/description/price and/or hidden flag as an **override** (kept separate from
  the source payload so refreshes preserve it).
- `sync-hiking-manitoba` → collector-only; upsert a sanitized batch of group posts by canonical URL.

See [`app/api/sources/route.ts`](../app/api/sources/route.ts) and
[05 — Social & the Facebook collector](05-social-collector.md).

## Data flow diagram (textual)

```
Public venue calendars ──fetch/parse──┐
City free-swim + pool directory ──────┤
Trails Manitoba KML (offline script) ─┤
                                      ▼
                              D1: listings + sources ──getCollection──► GET /api/listings ──► Winnigo UI
                                      ▲
Facebook (private group) ─Selenium─► candidates.json ─extract/paraphrase─► batch.json
                                      │                                   │
                                      │          publish-social.mjs (WINNIGO_ORIGIN + collector key)
                                      │                                   ▼
                                      └───────────── POST /api/sources (sync) + POST /api/photos/import ──► R2
Owner via /admin ──add-social / update / refresh──────────────────────► POST /api/sources
```

The extract/paraphrase step is done by whatever agent runs the collector (originally Codex; now any
terminal agent — see [`AGENTS.md`](../AGENTS.md)). `publish-social.mjs` targets `WINNIGO_ORIGIN`
(your deploy URL or localhost); the old Sites owner token is needed only when that origin is a
`.chatgpt.site` host.

## Why the app dir is so terse

Most `.ts`/`.tsx` files are written as extremely dense single-line-per-statement code (see
[`lib/store.ts`](../lib/store.ts), [`components/winnigo.tsx`](../components/winnigo.tsx)). This is a
deliberate house style, not minified output. Keep edits in the same style or reformat a whole file
intentionally. See [10 — Handover notes](10-handover.md).
