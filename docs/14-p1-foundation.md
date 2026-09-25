# P1 — Node.js foundation

Date: 2026-09-23. Baseline: `c1c29c5e24ec55de01a99fa776a0879afd191d41`.

## Delivered

- Standard Next.js 16.3.5 / React 19.2.6 on Node 22.22.1. Vinext, Vite and Wrangler were removed from default dependencies and startup/build commands. The standalone build includes its CSS, JavaScript and public assets. The original full Cloudflare release remains available by commit; reference configuration is in `legacy/cloudflare/`.
- Server-only configuration and service boundaries; `.env.local` setup, validation and a safe `.env.example`. Startup rejects missing Basic credentials, unsupported adapters, invalid ports/origins and non-loopback local mode. Environment overrides take precedence. Setup retains the owner's explicit password-free local preference from `.dev.vars` once and does not alter the old file.
- Repository and photo-storage interfaces with file-backed fixture adapters. Atomic snapshots serialize writes across local processes. Synthetic tests cover failed-write rollback and repeated imports retaining images, comments, hidden state and owner corrections. Data and media live outside `public/`; no source snapshots are imported into the discovery client bundle.
- Next request proxy plus API owner checks; default Basic owner access and source-scoped collector writes. Anonymous access to content and static assets is denied in Basic mode. The authorized local mode is retained only for loopback development. A public liveness route returns no sensitive data.
- Digest-pinned PostgreSQL 17.11 and SeaweedFS 4.47 development services, an explicit PostgreSQL migration ledger command, fixture seeding, a multi-stage Node Dockerfile, and web/worker Compose services. Container processes run as `node` and use Basic authentication.
- Separate worker process with startup validation, fixture-store readiness and heartbeat health check. No source jobs or schedules are enabled in P1.
- Fixed the P0 Leaflet lifecycle error by disabling zoom/fade animation and stopping map motion before disposal. Filter changes and unmounts no longer leave delayed animation callbacks accessing removed map panes. Zooming, pan, markers and source geometry remain available.
- Origin checks handle Next's internal localhost/container authority while validating the browser-facing Host or explicitly configured origin; arbitrary forwarded-host headers do not authorize writes.

Next's [proxy convention](https://nextjs.org/docs/app/api-reference/file-conventions/proxy) and [standalone output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output) were checked against the installed implementation and official documentation.

## Verification

- `npm test`: **31 passed**, including configuration, repository concurrency/rollback, import idempotence, overrides/hidden state, media keys and origin checks.
- `npm run typecheck` and `npm run build`: passed.
- Clean Docker `npm ci` and build succeeded without local credentials, Wrangler or a cloud account. The Docker context excludes secrets, local data and browser profiles. The standalone output also excludes `.env*`, `.dev.vars*` and local data directories.
- PostgreSQL/S3 connectivity and the idempotent foundation migration passed. `worker:check` passed. PostgreSQL, storage, web and worker Compose health checks passed.
- Dev CSS/JS checks: 2 stylesheets, 5 browser modules. Built Node checks: 2 stylesheets, 8 browser modules. Layout rules, MIME types and configured API access passed.
- Chrome 151 / Selenium 4.49 real-browser tests passed on dev (password-free loopback), the standalone production build (Basic), and the Docker web app (Basic). Covered computed grid/flex styles, completed loading, collection/search filters, owner corrections, hidden-item exclusion, comment links, two-photo full gallery/previous/next, approximate grouped lake markers, official summer/winter details, source dialog and admin edit/hide/show.
- The browser suite also zooms, changes collections and switches map/Explore five times, then asserts no severe JavaScript errors. The former `_leaflet_pos` regression is resolved in these checks.
- Basic boundary checks passed for owner pages/API/photos, anonymous denial, collector read/admin denial, forged middleware-subrequest headers, cross-origin writes and private static assets.

Local screenshots/reports are in ignored `.winnigo/p1-evidence/`. Credentials and actual legacy private records were not used as fixtures.

## Reproduce the QA checks

Install Selenium 4.49.0 into a dedicated Python venv and make Chrome available. From the repository root, use a separate fixture directory so test admin edits never touch normal data:

```sh
npm ci
npm run setup
WINNIGO_DATA_DIR=.winnigo/p1-qa WINNIGO_SEED_PROFILE=qa npm run db:seed
WINNIGO_DATA_DIR=.winnigo/p1-qa WINNIGO_AUTH_MODE=local PORT=5181 npm run dev
```

In another terminal:

```sh
WINNIGO_AUTH_MODE=local WINNIGO_CHECK_ORIGIN=http://127.0.0.1:5181 npm run check:assets
python scripts/check-browser.py --origin http://127.0.0.1:5181 --mode local --evidence .winnigo/p1-evidence/dev
npm run build
WINNIGO_DATA_DIR=.winnigo/p1-qa WINNIGO_AUTH_MODE=basic PORT=5182 WINNIGO_ORIGIN=http://127.0.0.1:5182 npm start
```

With the built server running:

```sh
WINNIGO_AUTH_MODE=basic WINNIGO_CHECK_ORIGIN=http://127.0.0.1:5182 npm run check:assets
npm run check:boundary
python scripts/check-browser.py --origin http://127.0.0.1:5182 --mode basic --evidence .winnigo/p1-evidence/built
```

The browser script expects the synthetic QA gallery and edits/restores its title. It does not log in to Facebook or use the collector profile. The boundary script targets a Basic-mode QA server and reads local credentials without printing them. Run dev and built browser checks sequentially when they share QA state.

## Deliberate P1 limits

The app uses the fixture adapters, not PostgreSQL or S3 for listings/photos yet. Its seeded public snapshots can contain expired events; existing filtering hides them. Neither old private Facebook content nor R2 images has migrated. UI notices identify snapshot mode; refresh requests return an explicit unavailable response instead of collecting during a page request. Filesystem fixtures are for one development host, not multi-host production.

The worker is an idle foundation with health reporting, not an autonomous collector. Durable jobs, schedules, retry policy and cloud browser operation remain P5/P6. Account login/preferences remain P3/P4. Basic mode is the interim owner gate; the user's explicitly requested loopback exception is preserved. Production data, site audience, active collector and schedules are unchanged.

P2 can now replace the fixture adapters, introduce reviewed PostgreSQL domain migrations and S3 media operations, and rehearse data import against the same UI and acceptance tests.

After verification, temporary QA servers and Compose services were stopped; the normal password-free Node dev server was left running on port 5173. Synthetic QA records/photos were removed from the container fixture volume. Local `.winnigo/p1-qa` remains an isolated reproducible test store.
