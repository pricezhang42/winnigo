# 10 — Handover notes

Practical guidance for the next person/agent: conventions, gotchas, coupling, and open work.

## Code conventions

- **Dense single-line style.** `lib/store.ts`, `lib/connectors.mjs`, `components/winnigo.tsx`,
  `app/api/sources/route.ts` pack many statements per line intentionally. Match it locally, or
  reformat a whole file on purpose — don't leave a file half-reformatted.
- **`.mjs` for shared runtime logic** imported by both the Worker and Node scripts
  (`connectors.mjs`, `free-swim.mjs`, `social.mjs`). Keep them dependency-light and isomorphic
  (they must run in the Workers runtime *and* under plain Node in scripts).
- **Raw D1 prepared statements**, not Drizzle, in the app path. `db/index.ts`/`getDb()` (Drizzle) is
  effectively unused. Don't mix ORMs into `lib/store.ts` without reason.
- **Winnipeg time is canonical.** Use `localDay()` for any "today"/date-boundary logic; don't use
  the server's local timezone.
- **Never render source content as HTML.** Everything goes through `clean()` / plain text.

## High-value coupling ("change X, also change Y")

- **Listing shape** is duplicated as an implicit contract across `connectors.mjs`, `free-swim.mjs`,
  `social.mjs`, `store.ts`, and the `Listing` type in `components/winnigo.tsx:14`. Add a field →
  update the producers and that type together.
- **Adding a venue source:** add to the `sources` array in `connectors.mjs`, write a parser branch,
  handle it in `parseSource`, add a snapshot via `import-snapshot.mjs`, and (if it should show in the
  admin/source strip) confirm the `getCollection` reports assembly still includes it. The
  `facebook` source id is special-cased out of the venue report list in a few places
  (`store.ts:37`).
- **Binding rename:** update `.openai/hosting.json`, `cloudflare-env.d.ts`, and every
  `env as ... {DB?/BUCKET?/WINNIGO_COLLECTOR_KEY?}` cast.
- **Production origin** `https://winnigo.wasdpyzlp.chatgpt.site` is hardcoded in
  `scripts/publish-social.mjs`. Update it if the Site URL changes.
- **Group id** `810758152436911` appears in `social.mjs` (comment-link validation),
  `collect-hiking-selenium.py`, and the community source. Keep them in sync.
- **Trail geometry matching** is name-based (`match` strings) in `trail-map.json` /
  `trail-map-anchors.json` via `resolveMapLocation`. New outings only appear on the map if a name
  match, anchor, or the small hardcoded area fallback hits.

## Gotchas

- **Parsers are brittle by design.** A source layout change → the source goes `error` and keeps its
  last listings (free swim is the exception that cancels missing sessions). Fixes are regex edits in
  `connectors.mjs`/`free-swim.mjs`; always confirm with a live run + `node --test`.
- **Refresh is visit-driven, not cron.** If nobody opens the app, venue data ages (max staleness is
  whenever the next visit + 6 h window elapses). Only the Facebook collector is scheduled, and only
  externally (Codex, local host).
- **The collector cannot run in the Worker.** It needs the local machine, a signed-in Chrome
  profile, and the Selenium venv. Treat coverage as best-effort and partial-aware.
- **Mock auth is portable-dev only.** Don't rely on it in managed-linux or production. To exercise
  `/admin` locally, use the `/signin-with-chatgpt` mock route.
- **`initialize()` runs on every `GET /api/listings`.** It's written to be idempotent and cheap
  (guards + `INSERT OR IGNORE`), but keep it that way — it's on the hot read path.
- **Overrides vs payload.** Owner edits live in the `override` column and `hidden` flag, merged over
  `payload` at read time. Never write owner corrections back into `payload`, or refreshes will erase
  them.

## Known open work / roadmap (from `WINNIGO.md` + `HIKING-COLLECTOR.md`)

- **Before public launch:** explicit admin allowlist; do not widen the admin API audience.
- Image/collection-feed **licensing/permission** resolution; private-group content review.
- More sources, official feed agreements, confirmed occurrence expansion, richer descriptions;
  reach the ~100-listing launch target.
- Place discovery beyond The Forks.
- **Instagram** has no automatic feed yet (manual-by-link only) — needs a specific account + method.
- Trail map coverage: many official trails are point-only (anchors) without full route geometry;
  amber markers are approximate areas, not confirmed entrances.
- Collector robustness: FB layout changes require selector maintenance in
  `collect-hiking-selenium.py`; fixture tests don't prove live compatibility.

## Verify-your-setup checklist

1. `npm run install:ci` then `npm run dev` → app loads at `:5173`, feed populates from seeds.
2. Visit `/signin-with-chatgpt?return_to=/admin` → `/admin` loads with source cards.
3. `node --test scripts/tests/*.test.mjs` and `npx tsc --noEmit` both pass.
4. (Optional, collector) `.sites-runtime/selenium-venv/bin/python scripts/collect-hiking-selenium.py --login`
   then `--headless`, then the collector fixture test.

## Reference conversation

Design history lives at `https://chatgpt.com/s/cx_6ab08abcb8808191b83713e6da46212b` (owner login
required; not fetchable while writing these docs). If you have access, skim it for rationale that
isn't obvious from the code, and fold anything durable back into these docs.
