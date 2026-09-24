# Winnigo — P0 baseline and compatibility record

Started 2026-09-21; completed checks recorded 2026-09-22.

Baseline commit: `c793ac3a8776aac65ca9ee9af6bd286db6938411`. The working tree was clean before P0. The application remains on its existing Vinext/Cloudflare runtime. No production data, audience, deployment or collector schedule has changed.

## Deliverables

- `scripts/fixtures/p0-discovery.json`: synthetic calendar, multi-session swim, community post/comment/photo, seasonal trail, approximate park location, hidden-state/override and preference examples. Duplicate imports are constructed from the same post with different tracking/host spelling. No private author identities or copied private text.
- `lib/contracts/discovery.mjs`: strict target contracts for imports, discovery responses and preferences. They preserve unknown values, seasonal variants and restrictions, require explanations for approximate locations, and keep Facebook imports restricted and categorized as Community Highlights. These contracts are deliberately not attached to legacy endpoints yet; P2 must write explicit legacy-to-target mappings and P3 must enforce authorization independently of validation.
- `scripts/tests/p0-contracts.test.mjs`: fixture/parser/contract regression tests using the existing test runner.
- `spikes/p0/`: an isolated, repeatable Node/Next/PostgreSQL/Drizzle/auth/queue/S3 compatibility project with exact package lock and digest-pinned service images. Includes legacy fixture seeding, browser QA and built-app access checks.

Reproduction instructions are in [the P0 README](../spikes/p0/README.md). Credentials, downloaded packages, generated builds and screenshot/log evidence are ignored. The normal application dependency lockfile is unchanged.

## Selected implementation versions

These are the versions actually exercised, not a claim that they will remain the latest. Reassess updates before deployment.

| Component | Tested version | Decision |
| --- | --- | --- |
| Node.js | 22.22.1 | Pin development baseline in the spike `.nvmrc`; minimum >=22.13. |
| Next.js | 16.3.5 | Standard Node production build; React/React DOM 19.2.6. |
| PostgreSQL | 17.11 | `postgres:17-alpine` pinned by image digest. |
| PostgreSQL driver | pg 8.23.0 | Connection pool used by Drizzle and auth probe. |
| ORM | drizzle-orm 0.45.3 | JSONB, transactional rollback and upserts tested. |
| Authentication | better-auth and @better-auth/drizzle-adapter 1.7.5 | Signup/signin/session/revocation tested through Drizzle. |
| Queue | pg-boss 12.33.4 | PostgreSQL queue; leases/retries and timezone-aware scheduling tested. |
| Development object storage | SeaweedFS 4.47, build c50733600 | Digest-pinned image; private S3 endpoint on loopback. |
| S3 client and signing | @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner 3.1137.0 | Private object and signed GET operations tested. |
| Browser QA | Chrome 151.0.7922.71 / Selenium 4.49.0 | Fresh temporary browser profile; fixture-only admin mutations. |

SeaweedFS is the development service, not a selected paid production storage provider. The adapter remains S3-compatible; a production provider needs its own integration test. Its configuration exposes only the S3 port, not internal service ports, and supplies generated access credentials.

Primary references consulted: [Better Auth Drizzle adapter](https://better-auth.com/docs/adapters/drizzle), [Better Auth database/migrations](https://better-auth.com/docs/concepts/database), [pg-boss releases](https://github.com/timgit/pg-boss/releases), [pg-boss job options](https://github.com/timgit/pg-boss/blob/master/docs/api/jobs.md), and [SeaweedFS quickstart](https://github.com/seaweedfs/seaweedfs). Exact installed packages were also inspected and exercised locally.

## Acceptance evidence

| Check | Result / scope |
| --- | --- |
| Original tests, typecheck, production build | Passed before P0: 21 tests. |
| Fixture tests plus existing suite | Passed: 25 tests; typecheck and legacy production build passed. |
| Legacy dev and built browser workflows | Both completed the listed checks below; the known Leaflet lifecycle error remains recorded. Screenshots were visually reviewed. |
| Legacy asset checks | Dev: 2 stylesheets and 1 browser module; built: 2 stylesheets and 6 browser modules. Layout CSS, MIME types and anonymous API denial passed. |
| Clean standalone installation | `npm ci`, `npm run setup`, dev and production build/start exercised in a disposable archive of the baseline commit. |
| Next production compatibility | Build, server-side library imports, real browser CSS grid and client button hydration passed. This is a small probe, not the full app migration. |
| PostgreSQL/Drizzle | JSONB read/write, repeated upsert without duplicate primary key, preservation of hidden flag/owner override, and failed transaction rollback passed. |
| Better Auth/Drizzle | Synthetic signup, password signin, stored session lookup, anonymous session denial and signout revocation passed. |
| pg-boss | Exclusive fetch, retry after failure and recovery after an abandoned active lease expired passed. A 09:00 America/Winnipeg schedule persisted correctly. Previewed executions crossed spring DST from 15:00Z to 14:00Z and fall DST from 14:00Z to 15:00Z. |
| SeaweedFS/S3 | Upload, content/metadata readback, HEAD length, signed GET, anonymous 403, delete and subsequent 404 passed. |
| Built Worker access boundary | Anonymous and collector reads of page/API/admin/photo returned 401. Owner reads returned 200. Collector general admin update returned 403. |

The compatibility probe was rerun successfully after the interruption. Service data remained isolated in the `winnigo-p0` Compose volumes.

## Baseline browser findings

The browser harness verifies computed grid/flex styles and completed client loading, Community Highlights and search filtering, hidden-item exclusion and owner title correction, linked discussion notes, full-image gallery loading and both navigation arrows, grouped approximate lake markers opening details, summer/winter Official Trails details, source information, and admin editing/hide/show. Dev and built asset checks inspect actual stylesheet/module responses and MIME types rather than only HTTP 200 HTML.

**Known baseline defect — map updates/unmount during zoom:** changing map collection filters or switching from Trail map to Explore while Leaflet is animating can throw `Cannot read properties of undefined (reading '_leaflet_pos')`. This was observed in the original baseline in Chrome. Markers and detail selection were exercised successfully, but the error can overlay the map afterward. The remaining independent checks reload the page after map testing; they do not establish that this transition is fixed. P1 acceptance must include fixing and regression-testing rapid map navigation. No runtime fix is included in P0.

## Limits and handoff to P1

P0 establishes compatibility and records existing behavior. It does not implement the production PostgreSQL schema, full migration, account screens, Google OAuth/email verification, source grants, worker scheduling, cloud browser sign-in or AI service.

The auth probe uses Better Auth's built-in migrator only to bootstrap a disposable database, then exercises the Drizzle adapter with mapped auth tables. P3 needs reviewed Drizzle migrations and account/grant/security tests. The queue probe verifies lease expiry and retries; heartbeat timing, restart catch-up policy and per-source concurrency still need P5 tests. S3 tests do not cover production durability, backup/restore, large uploads or lifecycle rules.

P1 should preserve the existing styling and verified workflows while replacing the runtime, use the pinned stack as its starting point, and carry the map transition defect into its acceptance criteria. No production cutover is authorized by completing P0.
