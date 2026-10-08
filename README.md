# Winnigo

Winnipeg and Manitoba events, places, official trails and community outings.

**P3 adds individual accounts and content permissions to the Node.js/PostgreSQL/S3 app.** Discovery and admin lists use server-side pagination. Existing D1/R2 data and the original hosted site have not been migrated or changed.

## Run locally

Requires Node.js 22.13+ (tested 22.22.1), npm and Docker Compose.

```sh
npm ci
npm run setup
npm run services:up
npm run db:migrate
npm run db:seed
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Setup creates ignored `.env.local` configuration; it preserves an existing file. For an existing P1 checkout, set `WINNIGO_REPOSITORY=postgres` and `WINNIGO_STORAGE=s3` there before migrating and seeding. Subsequent starts need the services running and `npm run dev`.

Fresh checkouts use invitation-only session authentication. See [account setup and owner bootstrap](docs/16-p3-accounts.md) before signing in. This checkout retains the owner's requested `WINNIGO_AUTH_MODE="local"`, so no password is required on loopback. Basic owner authentication remains available as a compatibility mode. Setup generates the private authentication secret without overwriting existing configuration. `.env.example` lists provider settings without real credentials.

Account login, email verification/reset, logout and session management are available in `session` mode at `/login` and `/account`. Google login requires OAuth credentials; real email requires SMTP configuration. A private local mail outbox supports loopback testing. Public signup and public browsing remain disabled.

The seed adds missing committed public snapshots and official trails without replacing existing records or owner corrections. Private Facebook posts/photos remain in legacy storage until an explicit migration. The `qa` seed profile adds synthetic community/gallery records for tests only; use a separate QA database. Live collection and scheduled jobs arrive in P5. Page reads never scrape sources.

The P1 file adapters remain available by explicitly setting both adapters to `fixture`, then running `npm run db:seed`. This does not require Docker and does not migrate records between backends. Existing `.winnigo/node` files remain intact.

## Production build locally

Stop the dev server first if using the same port:

```sh
npm run build
npm start
```

The build assembles Next's standalone server and static assets. `npm start` runs it on loopback port 5173. `npm run dev -- --port 5174` or `PORT=5174 npm start` selects another port. Environment variables supplied by the shell override `.env.local`. Startup validates auth mode, owner credentials, host, port and adapter selection without logging secrets.

In another terminal, verify real CSS and JavaScript delivery:

```sh
npm run check:assets
```

For another port use `WINNIGO_CHECK_ORIGIN=http://127.0.0.1:5174 npm run check:assets`. The script checks configured API access as well as styles/module MIME types. Basic mode protects pages, APIs, photos and static assets. New database-backed collector credentials permit only scoped import POSTs; they cannot read discoveries or make arbitrary admin edits. The old shared key is not accepted by Node. `/api/health` is an unauthenticated liveness check with no collection/configuration data.

## PostgreSQL and S3 development services

Requires Docker Compose; these have separate `winnigo-node` volumes from P0 and legacy state.

```sh
npm run services:up
npm run services:check
npm run db:migrate
```

PostgreSQL is on loopback port 55433; SeaweedFS S3 is on 58334. Setup writes their credentials to `.env.local`: PostgreSQL uses the fixed local login `winnigo` / `winnigo` (database `winnigo`), which is safe only because the port is bound to loopback; the S3 keys and auth secret are random. `db:migrate` applies the numbered domain migrations transactionally. `db:seed` adds missing public snapshots to the selected repository and preserves corrections; it does not migrate production data. PostgreSQL applies the password only when its volume is first created; to change it later, run `ALTER USER` and update `POSTGRES_PASSWORD` and `DATABASE_URL` together.

Stop the services with `npm run services:down`. To run the web app and its separate worker in containers:

```sh
docker compose --env-file .env.local --profile app up --build -d --wait
```

Open [http://127.0.0.1:5180](http://127.0.0.1:5180). The container defaults to session authentication, even if host development uses local mode. Configure SMTP/accounts before use; `WINNIGO_CONTAINER_AUTH_MODE=basic` retains the previous owner-only compatibility gate. It uses the same local PostgreSQL/S3 services, with container-specific service addresses. Both web and worker run as the unprivileged `node` user. To stop containers without deleting data:

```sh
docker compose --env-file .env.local --profile app stop
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run setup` | Generate local config once; preserves existing configuration |
| `npm run dev` | Standard Next.js development server |
| `npm run build` / `npm start` | Assemble and run standalone Node app |
| `npm run worker` | Collection worker: manual refreshes; daily source schedules with `WINNIGO_SCHEDULES=enabled` |
| `npm run check:p5` | Collection-job integration check (temporary schemas, no live sites) |
| `npm run worker:check` | Validate the selected store and exit |
| `npm run db:seed` | Add missing snapshots/QA fixtures; preserve existing records |
| `npm run db:migrate` | Apply pending PostgreSQL migrations |
| `npm run services:up` / `services:down` | Start/stop local PostgreSQL and SeaweedFS |
| `npm run services:check` | Authenticated PostgreSQL and S3 connectivity checks |
| `npm test` / `npm run typecheck` | Regression tests and TypeScript checks |
| `npm run check:assets` | Validate actual styles/scripts and configured API access |
| `npm run check:p3` | Isolated account/permission integration tests |
| `npm run accounts:manage -- …` | Operator invitations, roles, grants and service credentials |
| `npm run accounts:cleanup` | Preview account/security retention cleanup |
| `npm run check:p2` | Isolated PostgreSQL/S3 integration tests; requires services |
| `npm run media:cleanup` | Dry-run orphan photo cleanup; add `-- --apply` to delete eligible objects |
| `npm run check:boundary` | Basic-mode QA regression; use the QA database environment as described in P2/P3 docs |

P3 account setup and verification are in [P3 accounts](docs/16-p3-accounts.md). P2 storage, migration, browser QA and limits are in [P2 evidence](docs/15-p2-storage.md). Historical foundation checks are in [P1 evidence](docs/14-p1-foundation.md). The fixture adapter uses atomic snapshots and a cross-process write lock; it is for single-host development, not production storage. An interrupted write can leave `.winnigo/node/write.lock`; stop all processes before removing that stale lock. Never delete a live writer's lock.

## Legacy app and collector

The complete pre-P1 release is commit `c1c29c5e24ec55de01a99fa776a0879afd191d41`. [Legacy instructions](legacy/cloudflare/README.md) describe running it in a separate checkout, including the original Sites build path. Existing `.wrangler`, `.dev.vars`, browser profiles, remote D1/R2 and the old hosted site remain intact. The new `.env.local` applies only to the Node app.

[Selenium collector instructions](HIKING-COLLECTOR.md) and import scripts remain available. P3 does not change the active production scheduler, automatically redirect uploads to this checkout, or move private data. The [system design](docs/11-target-system-design.md), [implementation plan](docs/12-implementation-plan.md), and [documentation index](docs/README.md) track the migration.
