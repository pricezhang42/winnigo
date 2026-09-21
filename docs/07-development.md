# 07 — Development & operations

Full reference for the underlying starter/runtime is the root [`README.md`](../README.md). This is
the practical subset for Winnigo.

## Prerequisites

- Node.js `>= 22.13.0`.
- Python 3 + Selenium (only for the Facebook collector; isolated venv in
  `.sites-runtime/selenium-venv`, pinned in [`scripts/selenium-requirements.txt`](../scripts/selenium-requirements.txt)).

## Everyday commands ([`package.json`](../package.json))

```bash
npm run install:ci   # one locked install against the shared lockfile (don't overlap installers)
npm run dev          # vinext dev server, HMR, http://localhost:5173
npm run build        # build the deployable Sites/Worker artifact into dist/
npm run start        # preview the built Worker locally via Wrangler on 127.0.0.1 (D1/R2)
npm run lint         # eslint
npm run db:generate  # regenerate Drizzle migration SQL after editing db/schema.ts
```

`npm run dev`/`build` go through [`scripts/run-framework.mjs`](../scripts/run-framework.mjs), which
picks the **portable** vs **managed-linux** execution profile
(`.sites-runtime/execution-profile.json`, git-ignored). Portable runs vinext directly; managed-linux
uses Vite + `scripts/build-verified.sh`. If you reopen/move the checkout, re-run the plugin's
`configure-execution-profile.mjs` before project commands (see root README).

## Local sign-in (mock auth, portable only)

The portable profile fakes ChatGPT sign-in for loopback dev requests:

- Sign in: visit `/signin-with-chatgpt?return_to=/` → identity `local_seedy` / `seedy@sites.test`.
- Sign out: `/signout-with-chatgpt?return_to=/`.

Mock auth is disabled in managed-linux and absent from production builds. Hosted auth is
dispatch-owned. You need to be signed in to reach `/admin` and the owner-only `/api/sources`.

## Authentication model ([`app/chatgpt-auth.ts`](../app/chatgpt-auth.ts))

Sign in with ChatGPT (SIWC). Signed-in requests carry `oai-authenticated-user-id` /
`oai-authenticated-user-email` (and optionally a percent-encoded full name). Helpers:

- `getChatGPTUser()` — optional signed-in identity (returns null if anonymous).
- `requireChatGPTUser(returnTo)` — redirect anonymous users into SIWC (used by `/admin`).
- `chatGPTSignInPath` / `chatGPTSignOutPath` — build safe relative auth links.

Rules: the module is **server-only**; start SIWC as a **top-level navigation** (no fetch/prefetch);
never call the AuthAPI directly; mark protected pages `dynamic = 'force-dynamic'`. Use `userId`
(stable per user per Site) as the durable key; email/name for display only. SIWC proves identity, not
workspace membership — Winnigo currently relies on the Site being restricted to its owner. See
[08 — Security & privacy](08-security-privacy.md).

## Local D1 migrations

```bash
npm run db:generate    # after schema changes -> drizzle/*.sql
npm run build          # generates dist/server/wrangler.json (rebuild if bindings change)
# apply each pending migration in order:
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js \
  d1 execute DB --local --config dist/server/wrangler.json \
  --persist-to .wrangler/state --file drizzle/0000_greedy_mystique.sql
```

Use `.wrangler/state` (Wrangler adds the versioned subdirs). Don't replay already-applied local
migrations. This updates only the preview DB; publishing applies production migrations separately.

Because Winnigo seeds everything through `initialize()` from committed JSON, a fresh local DB
populates itself on the first `GET /api/listings` after the migration is applied.

## Tests

```bash
node --test scripts/tests/*.test.mjs   # connectors + free-swim parser tests
npx tsc --noEmit                       # type check
.sites-runtime/selenium-venv/bin/python scripts/tests/selenium_collector_test.py  # collector (needs venv + Chrome)
```

## Build / publish

Use the **Sites plugin skill** for install, build, and publish in the managed environment — the npm
scripts above are the standalone equivalents. This project does **not** use `wrangler.jsonc`;
bindings come from `.openai/hosting.json`. Production origin is
`https://winnigo.wasdpyzlp.chatgpt.site` (hardcoded in [`scripts/publish-social.mjs`](../scripts/publish-social.mjs)).

## Things that are git-ignored (don't commit)

`node_modules/`, `dist/`, `.next/`, `.vinext/`, `.wrangler/`, `.sites-runtime/` (execution profile,
Selenium venv, Chrome profile, collector key, candidate/enriched files), `.agents/`, `.codex/`,
Python `__pycache__/`, `*.tsbuildinfo`, `.env*`. See [`.gitignore`](../.gitignore).

## Regenerating data snapshots

```bash
node scripts/import-snapshot.mjs                 # refresh listings.json + sources.json from live sites
python3 scripts/import-official-trails.py        # refresh official-trails.json + anchors from Trails Manitoba
```

Commit the regenerated JSON. See [04 — Sources & connectors](04-sources-and-connectors.md).
