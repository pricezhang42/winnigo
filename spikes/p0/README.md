# P0 compatibility checks

This is a disposable compatibility project, **not the replacement Winnigo app**. Production dependencies, the legacy runtime and existing collector are unchanged. Exact npm versions are in `package.json`/`package-lock.json`; both service images are pinned by digest. Tested with Node 22.22.1, PostgreSQL 17.11 and SeaweedFS 4.47.

## Database, auth, queue and storage

From this directory:

```sh
npm ci
node setup.mjs
docker compose up -d --wait
npm test
npm run build
npm start
```

Requires Node >=22.13, npm and Docker Compose. `setup.mjs` generates ignored local credentials without printing them. PostgreSQL and the S3 endpoint bind only to loopback ports 55432 and 58333; Next uses 5188. The separate Compose project and volumes contain synthetic data only. Do not point the probe at a production database or bucket.

`probe.mjs` checks JSONB upsert/rollback and retention of hidden state and corrections; Better Auth signup/signin/session/revocation through Drizzle; queue exclusivity, retry and expired-lease recovery; 09:00 Winnipeg scheduling across both DST changes; private object put/head/get, metadata, signed reads and deletion. It can be run repeatedly. It creates auth tables using Better Auth's built-in migrator solely to bootstrap the disposable database, then uses the Drizzle adapter. P3 still needs reviewed, versioned Drizzle migrations and full auth policy tests.

The tiny Next app checks server imports and client CSS/hydration. It does not prove the entire existing Vinext app has been migrated. `npm start` intentionally serves this test app only on localhost.

Stop the Next terminal and run `docker compose stop` when done. `docker compose down --volumes` removes **this project's disposable test data** if a clean reset is wanted. Do not delete `.env` while retaining initialized database volumes, or the generated password will no longer match.

## Existing app browser baseline

Run from the repository root. Use a fresh `/tmp/winnigo-p0-legacy.*` directory; never seed the normal checkout. `seed-legacy.mjs` enforces this path guard. The checkout is an archive of the committed baseline, has fresh local credentials, and contains no collector browser profile or private source data.

```sh
P0_CHECKOUT=$(mktemp -d /tmp/winnigo-p0-legacy.XXXXXX)
git archive c793ac3a8776aac65ca9ee9af6bd286db6938411 | tar -x -C "$P0_CHECKOUT"
npm ci --prefix "$P0_CHECKOUT"
npm run setup --prefix "$P0_CHECKOUT"
node spikes/p0/seed-legacy.mjs "$P0_CHECKOUT"
npm run dev --prefix "$P0_CHECKOUT" -- --host 127.0.0.1 --port 5177
```

In separate terminals (retain the same `P0_CHECKOUT` value):

```sh
WINNIGO_CHECK_ORIGIN=http://127.0.0.1:5177 npm run check:assets --prefix "$P0_CHECKOUT"
npm run build --prefix "$P0_CHECKOUT"
npm start --prefix "$P0_CHECKOUT" -- --port 5178
```

Use Python with Selenium installed and Chrome available. A dedicated venv can be created with `python3 -m venv /tmp/winnigo-p0-python` followed by `/tmp/winnigo-p0-python/bin/pip install selenium==4.49.0`. The browser test creates a fresh temporary profile, reads only disposable credentials, and never opens social-media sources.

With both legacy servers and the tiny Next server running:

```sh
python spikes/p0/browser-check.py --legacy-checkout "$P0_CHECKOUT" --evidence spikes/p0/evidence/dev
python spikes/p0/browser-check.py --legacy-checkout "$P0_CHECKOUT" --legacy-port 5178 --evidence spikes/p0/evidence/built
WINNIGO_CHECK_ORIGIN=http://127.0.0.1:5178 npm run check:assets --prefix "$P0_CHECKOUT"
WINNIGO_CHECK_ORIGIN=http://127.0.0.1:5178 node --env-file="$P0_CHECKOUT/.dev.vars" spikes/p0/check-legacy-boundary.mjs
```

Screenshots, local logs and JSON reports go in ignored `evidence/`. The committed acceptance record is [P0 baseline](../../docs/13-p0-baseline.md). Refresh fixture timestamps with `seed-legacy.mjs` before rerunning after six hours, so page reads do not initiate public-source refreshes. Seeding resets the synthetic owner corrections and hidden flags in this disposable database.

Known baseline defect: changing map filters or leaving the map during a zoom animation can throw `Cannot read properties of undefined (reading '_leaflet_pos')`. The browser test reloads after testing the map to keep subsequent independent checks runnable; it records this limitation instead of treating map-to-Explore navigation as passing. P1 must add and pass that transition regression before acceptance.
