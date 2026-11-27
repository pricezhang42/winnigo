# 07 — Development & operations

The working guide is [`AGENTS.md`](../AGENTS.md); setup notes are in the root
[`README.md`](../README.md). This is the practical subset. Production deployment is in
[32 — Deployment](32-deployment.md).

## Prerequisites

- Node.js `>= 22.13.0`.
- Docker, for local PostgreSQL, S3-compatible storage and FlareSolverr ([`compose.yaml`](../compose.yaml)).
- Python 3 + Selenium only for the Facebook collector, in a private venv such as `.winnigo/venv`
  (pinned in [`scripts/selenium-requirements.txt`](../scripts/selenium-requirements.txt); see
  [HIKING-COLLECTOR.md](../HIKING-COLLECTOR.md)).

## Everyday commands ([`package.json`](../package.json))

```bash
npm ci                 # install
npm run setup          # create .env.local with generated secrets (never overwrites it)
npm run services:up    # PostgreSQL + S3-compatible storage + FlareSolverr via Docker Compose
npm run db:migrate     # apply migrations/postgres in order
npm run db:seed        # official trails (WINNIGO_SEED_PROFILE=qa adds synthetic QA items)
npm run dev            # Next.js dev server, http://127.0.0.1:5173
npm run build          # optimized Next.js build (standalone server)
npm start              # run the built app
npm run worker         # collection jobs; schedules only with WINNIGO_SCHEDULES=enabled
npm run collect -- --list            # event sources; `-- <source> --publish` collects one
npm run events:duplicates            # recompute and list cross-source duplicate events
npm run accounts:manage -- <command> # invite, bootstrap-owner, roles, grants (docs/16)
npm run db:backup / db:restore       # backups to and from the backup bucket (docs/32)
```

`npm run dev`/`build`/`start` go through [`scripts/node-app.mjs`](../scripts/node-app.mjs), which
validates configuration before starting Next.js. Event collection needs the `WINNIGO_EXTRACTION_*`
settings and `OPENAI_API_KEY`; WAG also uses FlareSolverr on loopback port 8191, started by
`services:up` ([18 — Event collection](18-event-collection.md)). The pre-P1
Cloudflare/Vinext/Sites commands were removed; they remain in the rollback release described in
[`legacy/cloudflare/README.md`](../legacy/cloudflare/README.md).

## Authentication model ([`lib/server/config.mjs`](../lib/server/config.mjs), [`proxy.ts`](../proxy.ts))

`WINNIGO_AUTH_MODE` selects the model; `npm run setup` writes `session` for new checkouts.

- **`session`:** Better Auth accounts in PostgreSQL ([`lib/server/accounts.mjs`](../lib/server/accounts.mjs)).
  Sign-up is invitation-only unless `WINNIGO_SIGNUP=open`; email must be verified; the single owner
  is promoted only by `npm run accounts:manage -- bootstrap-owner`. Outside loopback the origin must
  be HTTPS. See [16 — P3 accounts](16-p3-accounts.md) and [31](31-public-access-and-accounts.md).
- **`local`:** the owner, without a password, on a loopback host and origin only. For the owner's
  own development.
- **`basic`:** HTTP Basic with `WINNIGO_ADMIN_USER` / `WINNIGO_ADMIN_PASSWORD`; a compatibility
  mode.

[`proxy.ts`](../proxy.ts) gates every page and API route. Without a principal, pages redirect to
`/login` and APIs answer `401`, except the sign-in shell, `/api/health`, `robots.txt`, public reads
when `WINNIGO_PUBLIC_BROWSING=enabled`, and the collector import routes, which check their own
scoped credentials ([08 — Security & privacy](08-security-privacy.md)). It also sets the security
headers ([`lib/security-headers.mjs`](../lib/security-headers.mjs)). Routes check roles and content
grants themselves ([`lib/server/access.mjs`](../lib/server/access.mjs)).

## Database migrations

Migrations are numbered SQL files in [`migrations/postgres/`](../migrations/postgres), applied in
order by `npm run db:migrate` ([`scripts/migrate-postgres.mjs`](../scripts/migrate-postgres.mjs)),
which records them in `winnigo_schema_migrations`. Add a schema change as the next numbered file;
never edit an applied one. `npm run db:reset -- --yes` resets a local pre-baseline database.
In production the one-off `release` container runs migrations and the seed before a new version
starts ([32](32-deployment.md)).

## Tests

```bash
npm test             # node --test scripts/tests/*.test.mjs
npm run typecheck    # tsc --noEmit
npm run lint         # eslint (clean; keep it that way)
npm run check:events # event store publishing (temporary schema)
npm run check:p2     # PostgreSQL/S3 integration (temporary schema and object prefix)
npm run check:p3     # accounts and permissions (temporary schema)
npm run check:p5     # job queue and schedules
npm run check:assets # real CSS/JS responses and layout for a running server
.winnigo/venv/bin/python scripts/tests/selenium_collector_test.py  # Facebook collector (venv + Chrome)
```

The `check:*` database checks need `npm run services:up`. Browser regression runs against a
separate QA database ([15 — P2 storage](15-p2-storage.md)). GitHub Actions runs the same checks
(except `check:assets` and the browser regression) on every pull request
([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)); a change can then be tried on the
staging site before production ([32 — Deployment](32-deployment.md#staging)).

## Verify the access boundary

With a dev or built server running in session mode: an anonymous page request must redirect to
`/login` and an anonymous API request must return `401`; a signed-in user must not reach admin
routes; collector credentials must reach only their POST import routes. `npm run check:p3` covers
these at the account level, `npm run check:boundary` covers Basic mode, and `npm run check:assets`
confirms that styles and scripts actually load (an HTML `200` alone is not evidence).

## Things that are git-ignored (don't commit)

`node_modules/`, `.next/`, `dist/`, `.env*` (except `.env.example` and `.env.production.example`),
`.dev.vars*`, `/.winnigo/` (venv, browser profiles, mail outbox, collection logs, raw candidates),
`/.sites-runtime/`, `/.wrangler/`, `.agents/`, `.codex/`, Python `__pycache__/`, `*.tsbuildinfo`.
See [`.gitignore`](../.gitignore). **Never** print or commit `.env.local`, `.env.production`, the
collector key or provider secrets.

## Data

```bash
npm run db:seed                            # official trails from lib/data/official-trails.json
python3 scripts/import-official-trails.py  # refresh official-trails.json + anchors from Trails Manitoba
npm run collect -- <source> --publish      # events and places, by AI extraction (docs/18)
```

Only the official trails are seeded; commit regenerated trail JSON. Events and places come from
collection, not from committed snapshots. See [04 — Sources & connectors](04-sources-and-connectors.md).
