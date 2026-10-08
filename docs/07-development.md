# 07 — Development & operations

The standalone working guide is [`AGENTS.md`](../AGENTS.md); the app's own setup notes are in the
root [`README.md`](../README.md). This is the practical subset.

## Prerequisites

- Node.js `>= 22.13.0`.
- Python 3 + Selenium (only for the Facebook collector; isolated venv in
  `.sites-runtime/selenium-venv`, pinned in [`scripts/selenium-requirements.txt`](../scripts/selenium-requirements.txt)).

## Everyday commands ([`package.json`](../package.json))

```bash
npm ci               # install (npm run install:ci is an alias)
npm run setup        # create .env.local with generated secrets (never overwrites it)
npm run services:up  # PostgreSQL + S3-compatible storage via Docker Compose
npm run db:migrate   # apply migrations/postgres in order
npm run db:seed      # seed snapshot data (WINNIGO_SEED_PROFILE=qa for synthetic QA data)
npm run dev          # Next.js dev server, http://127.0.0.1:5173
npm run build        # optimized Next.js build (standalone server)
npm start            # run the built app
npm run worker       # background worker (no collection schedules until P5)
npm test             # node --test on scripts/tests/*.test.mjs
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run format       # prettier (Python: ruff format scripts)
npm run check:assets # verify real CSS/JS responses and layout for a running server
npm run check:p2     # PostgreSQL/S3 integration checks (temporary schema)
npm run check:p3     # accounts and permissions checks (temporary schema)
```

`npm run dev`/`build`/`start` go through [`scripts/node-app.mjs`](../scripts/node-app.mjs), which
validates configuration before starting Next.js. The pre-P1 Vinext/Sites commands (`deploy`,
`build:sites`, `db:generate`) and their helper scripts were removed; they remain available in the
rollback release described in [`legacy/cloudflare/README.md`](../legacy/cloudflare/README.md).

## Authentication model ([`lib/auth-policy.mjs`](../lib/auth-policy.mjs), [`lib/auth.ts`](../lib/auth.ts))

`WINNIGO_AUTH_MODE` selects the model:

- **`basic` (default, standalone):** HTTP Basic auth. The owner is whoever presents
  `WINNIGO_ADMIN_USER` : `WINNIGO_ADMIN_PASSWORD`. [`worker.ts`](../worker.ts) gates the entire site —
  anonymous requests get a `401` with `WWW-Authenticate: Basic`. `getOwner()` (in `lib/auth.ts`)
  returns `{userId:'owner'}` for a valid Basic header, else null; `/admin` and `/api/sources` use it.
- **`sites` (legacy, opt-in):** trusts `oai-authenticated-user-id` / `-email` headers injected by the
  ChatGPT Sites dispatch, which enforces the owner-only audience. Standalone mode explicitly does
  **not** trust those headers (a portability test asserts forged ones are rejected).

To sign in locally, use the owner credentials in the generated `.dev.vars` when the browser prompts.
`isCollector()` (collector key) is separate and scoped — see [08 — Security & privacy](08-security-privacy.md).

## Local D1 migrations

`npm run setup` runs `db:migrate` for you. Manual flow after a schema change:

```bash
npm run db:generate    # after editing db/schema.ts -> drizzle/*.sql
npm run db:migrate     # wrangler d1 migrations apply DB --local --config wrangler.json --persist-to .wrangler/state
```

`migrations_dir` is set to `drizzle/` in [`wrangler.json`](../wrangler.json), so `wrangler d1
migrations apply` handles ordering. Use `.wrangler/state` (Wrangler adds versioned subdirs). Because
Winnigo seeds everything through `initialize()` from committed JSON, a fresh local DB populates
itself on the first `GET /api/listings` after migration. Production migrations apply on deploy.

## Tests

```bash
npm test          # connectors + free-swim + portability parser/auth tests (21)
npm run typecheck # tsc --noEmit
.sites-runtime/selenium-venv/bin/python scripts/tests/selenium_collector_test.py  # collector (needs venv + Chrome)
```

The portability suite ([`scripts/tests/portability.test.mjs`](../scripts/tests/portability.test.mjs))
verifies standalone auth rejects forged Sites headers, the collector key is scoped to POST import
endpoints, and `publish-social.mjs` is local-by-default.

## Deploy

```bash
npm run deploy    # build + wrangler deploy --config dist/server/wrangler.json
```

Deploys to **your own Cloudflare account** (configure `wrangler login` and the D1/R2 resources named
in [`wrangler.json`](../wrangler.json) first). Set the secrets there — `WINNIGO_ADMIN_USER`,
`WINNIGO_ADMIN_PASSWORD`, `WINNIGO_COLLECTOR_KEY` — via `wrangler secret put`. No ChatGPT Sites step
is involved. `build:sites` + the old Sites publish flow remain only for the legacy deployment the
user already had.

## Verify the auth boundary

After `npm start` (built Worker): an anonymous request must return **401**; owner Basic auth must
work; the collector key must grant only the two POST import endpoints, never reads or admin. This is
the standalone equivalent of the old "owner-private" guarantee.

## Things that are git-ignored (don't commit)

`node_modules/`, `dist/`, `.next/`, `.vinext/`, `.wrangler/`, `.dev.vars*` (owner + collector
secrets), `/.winnigo/`, `.sites-runtime/` (Selenium venv, Chrome profile, collector key,
candidate/enriched files), `.agents/`, `.codex/`, Python `__pycache__/`, `*.tsbuildinfo`, `.env*`.
See [`.gitignore`](../.gitignore). **Never** print or commit `.dev.vars` or the collector key.

## Regenerating data snapshots

```bash
node scripts/import-snapshot.mjs                 # refresh listings.json + sources.json from live sites
python3 scripts/import-official-trails.py        # refresh official-trails.json + anchors from Trails Manitoba
```

Commit the regenerated JSON. See [04 — Sources & connectors](04-sources-and-connectors.md).
