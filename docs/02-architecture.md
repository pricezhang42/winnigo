# 02 — Architecture

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

## Bindings

Declared in [`.openai/hosting.json`](../.openai/hosting.json):

```json
{ "d1": "DB", "r2": "BUCKET", "project_id": "appgprj_6aab5c23b4708191a0eae696e6fdad83" }
```

- `DB` → D1 database (listings + sources). Read from `env.DB`.
- `BUCKET` → R2 bucket for photos under the `photos/<sha256>` key space.
- `WINNIGO_COLLECTOR_KEY` → a secret configured in Sites (not in the repo) that authorizes only the
  Facebook group-sync action and photo import from the collector host.
- Types for the optional bindings live in [`cloudflare-env.d.ts`](../cloudflare-env.d.ts); update it
  if binding names change.

`vite.config.ts` simulates these bindings for local dev. Local D1/R2 state persists under
`.wrangler/state` (git-ignored).

## Routes

App Router routes under [`app/`](../app):

| Path | File | Purpose |
| --- | --- | --- |
| `/` | [`app/page.tsx`](../app/page.tsx) → [`components/winnigo.tsx`](../components/winnigo.tsx) | Public discovery UI. |
| `/admin` | [`app/admin/page.tsx`](../app/admin/page.tsx) → [`components/admin.tsx`](../components/admin.tsx) | Owner-only collection desk. Requires ChatGPT sign-in. |
| `GET /api/listings` | [`app/api/listings/route.ts`](../app/api/listings/route.ts) | Public collection read; triggers init + refresh-on-visit. |
| `GET/POST /api/sources` | [`app/api/sources/route.ts`](../app/api/sources/route.ts) | Owner/collector read + all mutations (refresh, add-social, update, sync-hiking-manitoba). |
| `POST /api/photos/import` | [`app/api/photos/import/route.ts`](../app/api/photos/import/route.ts) | Store a Facebook CDN photo into R2; returns `/api/photos/<hash>`. |
| `GET /api/photos/[id]` | [`app/api/photos/[id]/route.ts`](../app/api/photos/[id]/route.ts) | Serve a stored photo (private cache) by 64-hex id. |

Reserved dispatch-owned auth routes (`/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`)
are **not** implemented in-app — the Sites platform owns them. See [07 — Development](07-development.md).

All API routes set `export const dynamic = 'force-dynamic'` because they depend on per-request
identity headers and live storage.

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

`POST /api/sources` handles four actions, gated by auth (owner ChatGPT session **or** the
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
Facebook (private group) ─Selenium─► candidates.json ─Codex extract─► batch.json
                                      │                                   │
                                      │                   publish-social.mjs (owner token + collector key)
                                      │                                   ▼
                                      └───────────── POST /api/sources (sync) + POST /api/photos/import ──► R2
Owner via /admin ──add-social / update / refresh──────────────────────► POST /api/sources
```

## Why the app dir is so terse

Most `.ts`/`.tsx` files are written as extremely dense single-line-per-statement code (see
[`lib/store.ts`](../lib/store.ts), [`components/winnigo.tsx`](../components/winnigo.tsx)). This is a
deliberate house style, not minified output. Keep edits in the same style or reformat a whole file
intentionally. See [10 — Handover notes](10-handover.md).
