# P2 — PostgreSQL and S3 storage

Status: implemented and locally verified, 2026-09-24. Production D1/R2, the old site, collector destination and scheduler are unchanged. P3 accounts and grants are not implemented yet.

## Storage and discovery

Numbered SQL migrations create sources, listings, canonical source identities, occurrences, locations, editorial overrides, media and ordered associations, comment notes, collection runs, audit records and migration checkpoints. Authentication tables remain reserved for P3. Migrations use a ledger and transaction/advisory lock; applying them again is safe.

The PostgreSQL repository keeps original payloads alongside the effective searchable document and normalized associations. Writes and collector batches are transactional. Canonical Facebook identities strip tracking parameters; stable IDs cannot change sources. Repeated imports preserve hidden state, owner corrections, photo order and comment links. Concurrent writers serialize through a database advisory lock.

`GET /api/listings` and `GET /api/sources` accept validated bounded queries: query, collection, category, area, tab, quick, season, difficulty, distance, limit and offset; Saved uses a comma-separated `ids` list (maximum 200). Discovery defaults to 24 records, admin requests 50, and the API caps pages at 100. Counts and page items use one database snapshot. Filtering and deduplication precede a deterministic source-interleaved ordering. `/api/listings/[id]` provides an owner-authenticated detail lookup. Hidden, cancelled and expired items are excluded from discovery. Admin queries include them.

The browser no longer downloads the whole listing collection. It loads additional pages explicitly, including on the map. Map counts and markers describe the loaded results; “Show more discoveries” loads more. Exact route geometry is never inferred from a park/lake point. Collection labels, seasonal variants, swim restrictions, uncertain distances and source attribution are preserved.

All reads retain the owner gate, with the owner's explicit password-free loopback development exception. Basic mode protects assets, listings, admin and photos; collector credentials only authorize scoped import POSTs. Individual users and grants arrive in P3.

## Private media

Objects use SHA-256 content IDs and private S3 keys; API URLs remain `/api/photos/<hash>`. The adapter verifies size/hash on upload and read, rejects identity/metadata collisions, and preserves ordered gallery references. Identical bytes reuse one object across listings. The database reserves uploads before writing S3, so an interrupted upload remains protected.

`npm run media:cleanup` reports at most 100 eligible orphan IDs without deleting. `npm run media:cleanup -- --apply` rechecks each object transactionally and deletes only ready, unreferenced objects whose creation time and upload lease are older than 24 hours. Referenced objects, unfinished uploads and every unfinished migration block the relevant cleanup. A migration left running after failure must be repaired/resumed; do not clear its checkpoint merely to force cleanup.

## Legacy migration rehearsal

These tools are explicit operator commands, not automatic startup actions. Use an authorized local SQLite copy/export of D1 and source R2 credentials with read-only object access. They never fetch production credentials or change source storage permissions. SQL-text exports must first be restored into a separate SQLite file. Never operate on the live database file during writes.

```sh
# SQLite export plus already-downloaded, content-addressed photo files:
npm run migrate:export -- --database /private/legacy.sqlite --output .winnigo/export --photos-dir /private/photos

# Alternatively omit --photos-dir, then preview/copy the referenced R2 objects:
npm run migrate:media -- .winnigo/export/manifest.json
npm run migrate:media -- .winnigo/export/manifest.json --apply

# Target PostgreSQL/S3 are selected through the current environment:
npm run migrate:import -- .winnigo/export/manifest.json
npm run migrate:import -- .winnigo/export/manifest.json --apply
```

For the R2 copy, supply `LEGACY_S3_ENDPOINT`, `LEGACY_S3_BUCKET`, `LEGACY_S3_ACCESS_KEY` and `LEGACY_S3_SECRET_KEY` through a private environment, not source control. The source prefix defaults to `photos/`; `LEGACY_S3_PREFIX` permits another explicitly configured source namespace. Each copied photo and the manifest are checkpointed atomically, so re-running is safe. No source objects are deleted.

Import dry-runs validate all record identities, referenced media, file paths, sizes and SHA-256 checksums before reporting counts and an identity-preserving ID map. Different target IDs for the same source post require operator reconciliation; the tool does not silently remap them. Apply records a manifest hash and progress, uploads media first, and imports records in atomic batches. A per-manifest lock prevents simultaneous execution of the same migration. Re-running verifies/replays batches idempotently and preserves existing target editorial state. Reconciliation checks original payloads, source/IDs, hidden state, corrections, ordered associations and stored photo checksums before marking complete. Do not edit imported listings concurrently with a migration rehearsal.

A production cutover still requires P8's authorized real-data rehearsal, source/status count reconciliation, backup/restore, write pause, delta reconciliation and audience decision. Local fixture success does not imply production was migrated.

## Verification and repeatable QA

Verified locally:

- 33 unit/regression tests, TypeScript and optimized Next production build.
- `npm run check:p2`: temporary PostgreSQL schema and S3 namespace, removed after the run. Covers SQL rollback/concurrent imports, stable identity and correction preservation, source diversity/pagination/search, hidden records, unknown distance and approximate locations, private S3 access, content collisions/reuse, SQLite export and S3 copy, migration dry-run/interruption/restart/checksums, and safe cleanup.
- All 709 public fixture records compared equal to PostgreSQL records, including original payloads, IDs, hidden state and overrides. Synthetic community data lives in a separate QA database.
- Chrome 151 against development and optimized servers: CSS grid/topbar, completed client loading, 24-to-48 pagination, collection/search filters, hidden/overridden items, gallery next/previous, comments, grouped lake markers, five map zoom/unmount cycles, seasonal details, source dialog and admin edit/hide/show.
- Production Basic access boundary: owner reads succeed; anonymous/collector reads, forged internal headers and cross-origin edits fail. Static assets and photos remain gated.
- Docker web and worker healthy as unprivileged users, connected to PostgreSQL and private S3; actual styles/scripts/API verified at port 5180.

Browser QA setup, with services already running:

```sh
node scripts/setup-qa.mjs
npm run build
node --env-file=.winnigo/p2-qa.env scripts/node-app.mjs start
# Separate terminal:
WINNIGO_CHECK_ORIGIN=http://127.0.0.1:5182 node --env-file=.winnigo/p2-qa.env scripts/check-boundary.mjs
WINNIGO_AUTH_MODE=basic WINNIGO_CHECK_ORIGIN=http://127.0.0.1:5182 npm run check:assets
python3 scripts/check-browser.py --origin http://127.0.0.1:5182 --mode basic --evidence .winnigo/p2-evidence/build
```

The browser script requires Selenium and Chromium/Chrome. QA setup permits only a loopback database, creates `<database>_p2_qa`, seeds synthetic records and writes private environment overrides under `.winnigo`. It leaves the ordinary database unchanged. Browser evidence is local under `.winnigo/p2-evidence`; no private screenshots are committed.

Known limits: offset pages can shift when records change between requests; search is literal substring SQL suitable for the current collection, not a production load benchmark. Source reports are bounded by configured source count. Uploading rows intentionally require operator recovery instead of automatic deletion. Collection scheduling remains P5; user accounts/preferences remain P3/P4. Public launch, real-data cutover and production load/restore tests remain P8.
