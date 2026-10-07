# P3 — Individual accounts and permissions

Implemented and verified locally on 2026-09-24. Real Google OAuth and SMTP delivery still require the owner's provider configuration and a live-provider acceptance check. No production deployment, audience change or collector cutover was performed.

## Progress review — 2026-10-06

P3 implementation and local acceptance are recorded in commit `bcdf423`. Retained account and owner-session browser reports both show a pass, including account verification/reset/deletion, device-bookmark isolation, galleries, maps and admin corrections. The progress review did not rerun the complete test suite.

Remaining activation work is provider configuration and a live Google/SMTP acceptance check. The normal local workflow retains password-free loopback access; account mode is available separately. PostgreSQL preferences, bookmarks, cross-device synchronization and personalized ranking are P4, not completed P3 features. Production cutover and replacement of the existing collector remain later phases.

## Account mode and first owner

The normal local app keeps the requested `WINNIGO_AUTH_MODE=local` password-free loopback experience. `basic` remains a compatibility mode. New setups default to `session`, backed by Better Auth 1.7.6 and PostgreSQL. Session mode exposes the login shell and static assets, but requires authentication for discovery, admin and media. Public browsing and unrestricted signup are disabled.

Run setup and migrations before using accounts:

```sh
npm run setup
npm run services:up
npm run db:migrate
npm run accounts:manage -- invite your-email@example.com
```

Set `WINNIGO_AUTH_MODE=session` in private `.env.local`. Keep the generated `BETTER_AUTH_SECRET` stable and private. For local email testing only, set `WINNIGO_MAIL_MODE=file`; use `WINNIGO_MAIL_DIR=.winnigo/mail` or another private directory. Restart the app, visit `/login`, choose “I have an invitation”, and register with the invited email. Local verification links are JSON files in that private outbox. Open the matching link locally; never publish these files or paste verification/reset links into logs.

An invitation lasts seven days and permits registration; it does not assign a privileged role. After verification, the operator explicitly promotes the intended owner:

```sh
npm run accounts:manage -- bootstrap-owner your-email@example.com
```

The command requires an existing verified account and refuses if an owner already exists. The database enforces a single owner. No first-signup rule, profile field or request header can grant ownership.

Other operator commands:

```sh
npm run accounts:manage -- role member@example.com admin
npm run accounts:manage -- role member@example.com user
npm run accounts:manage -- disable member@example.com
npm run accounts:manage -- transfer-owner current@example.com next@example.com
npm run accounts:manage -- grant-source member@example.com facebook
npm run accounts:manage -- revoke-source member@example.com facebook
npm run accounts:manage -- grant-listing member@example.com LISTING_ID
npm run accounts:manage -- revoke-listing member@example.com LISTING_ID
```

These are trusted filesystem/operator operations, not public HTTP endpoints. Disabling a non-owner revokes their sessions. Transfer requires the current owner and a different verified, enabled target; it is atomic. Invite commands do not send invitation messages; the operator shares the site address through their usual channel.

## Email and Google configuration

Email/password login requires verified email. Verification, reset and confirmed account deletion are implemented. Passwords require at least 12 characters; reset revokes existing sessions. Logout, listing/revoking sessions and signing out other devices are available at `/account`.

For actual delivery, configure `WINNIGO_MAIL_MODE=smtp`, `SMTP_HOST`, `SMTP_PORT` (465 or the provider's STARTTLS port), `SMTP_FROM`, and optional `SMTP_USER` / `SMTP_PASSWORD`. TLS certificate checks remain enabled. The file outbox refuses non-loopback hosts/origins and is never served by an API. Configure SMTP before enabling invitations on a hosted app. Delivery failures do not create a usable unverified login; provider error detail is not returned to clients.

Google becomes available when both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set. Configure the OAuth redirect URL as:

```text
https://YOUR_HOST/api/auth/callback/google
```

Use the exact configured `WINNIGO_ORIGIN`; local QA uses `http://127.0.0.1:5193/api/auth/callback/google`. Google accounts must also be invited and have verified email. Automatic linking of different provider accounts is disabled. OAuth tokens stored by the auth provider are encrypted with the auth secret. Do not rotate/delete that secret without planning session/token invalidation.

The implementation follows the pinned library's [database schema](https://better-auth.com/docs/concepts/database), [email/password options](https://better-auth.com/docs/authentication/email-password), and [Google integration](https://better-auth.com/docs/authentication/google). Reviewed SQL migrations own the schema; the web process does not run automatic auth migrations.

## Content permissions

- Owner: collection administration and access to restricted items/photos.
- Admin: collection management for records they may read. Admin status alone does not reveal private community content, permit social imports or issue grants.
- User: authenticated public-source discoveries plus explicitly granted source/listing access; no administration.
- Collector: only scoped ingestion, never a user session or discovery reader.

Legacy Facebook/Instagram records default to restricted. Source/listing grants are checked in SQL before deduplication, source diversity, pagination, counts and area facets. Detail and photo routes enforce the same principal; a photo requires an accessible, active listing association. Source reports for non-owners count only visible authorized records and omit private run errors. Reads use `no-store`; signed session-cookie caching is disabled and roles/enabled status are read from PostgreSQL, so revocation applies on the next request. Already-downloaded bytes cannot be recalled.

No caller-supplied user ID, role, Basic header in session mode, or platform identity header is trusted. `/api/me` returns only the current account. Existing device bookmarks are now stored under the signed-in user's ID; the old shared browser key remains exclusive to local/Basic owner mode. Server preferences/bookmarks and explicit legacy-bookmark import remain P4; no cross-user preference/bookmark endpoints exist yet.

## Collector credential migration

The Node app no longer accepts the shared `WINNIGO_COLLECTOR_KEY`. The archived legacy app and active old dispatcher remain unchanged. Do not redirect the existing production collector during P3.

```sh
npm run accounts:manage -- issue-collector facebook "Local reader" /private/new-collector.json
npm run accounts:manage -- revoke-collector CREDENTIAL_ID
```

Issuance writes the random token once to a new mode-0600 file; only its SHA-256 hash is stored in PostgreSQL. Tokens default to 90 days, are revocable, and carry a Facebook source scope. Configure the existing import client's `x-winnigo-collector-key` header with the new token only when intentionally targeting this Node app. The source route accepts only the Hiking Manitoba batch action; photo import accepts only the existing Facebook photo formats/URLs. Reads and arbitrary editorial changes fail even with a valid collector token. Revocation is checked on every request.

## Request protection and retention

Cookie-authenticated POSTs require the exact configured Origin. Auth requests accept bounded JSON (16 KiB); source imports retain the 250 KB bound, photo metadata 8 KB and image bytes 8 MB. Better Auth performs its own OAuth state/CSRF checks. Session cookies are HttpOnly, SameSite=Lax and Secure on HTTPS. Session mode refuses an HTTP origin outside loopback. Proxies must not log verification/reset URLs; Next incoming-request logging is disabled for this reason.

Database-backed limits cover auth globally (120 requests/minute), an email key (10 attempts/5 minutes), imports per identity (60/minute), and photos per identity (120/minute), alongside Better Auth limits. Raw email/credential/IP strings are not stored in application rate-limit keys. Forwarded IP headers are not trusted; the conservative shared auth limit can throttle simultaneous users and should be tuned alongside a trusted ingress before launch. Limits fail closed if storage is unavailable.

Security audit records contain action codes, account IDs and timestamps, not passwords, raw tokens, email bodies or private post text. `npm run accounts:cleanup` previews cleanup; `npm run accounts:cleanup -- --apply` removes expired sessions/verifications/invitations, day-old application rate buckets, and audit/expired credential records older than 90 days. Cleanup is an explicit operator job until scheduling arrives in P5.

Account deletion requires an emailed confirmation. It cascades provider accounts, sessions, role rows and grants; audit account IDs become null. Shared collection records and their source attribution remain. Owner deletion is blocked until ownership is transferred. Current device-local bookmarks are not server records; clear browser storage to remove their local copy. P4 must give new preference/bookmark tables account foreign keys with cascading deletion and include them in deletion tests.

Production backup retention is not yet provisioned: P8 must configure encrypted backups, a maximum 30-day retention window and a deletion replay process after restore. Until then, do not claim account deletion immediately erases historical backups. Local QA data/outboxes are synthetic and can be removed after testing; real mail outboxes, if used locally, should be cleared after their one-hour verification/reset links expire.

## Evidence and repeatable checks

Passed:

- 35 unit/regression tests, TypeScript, optimized production build and existing P2 integration tests.
- Reviewed auth migration compared against the pinned Better Auth schema: no missing tables or fields.
- `npm run check:p3`: isolated PostgreSQL schema, invited/uninvited signup, verification, login/reset/logout/session revocation, own-profile isolation, confirmed deletion, explicit owner bootstrap, SQL grants/facets/counts/media filtering, scoped token revocation, and rate limiting. Google authorization URL, callback and state generation tested without contacting Google.
- Actual Next HTTP checks: anonymous/session access, unauthorized listing/photo lookups, immediate grant revocation, own profile, admin rejection, Origin/body limits, valid/revoked service tokens and rejection of the old shared collector secret.
- Chrome: styled login, invited signup and email verification, login, private-content exclusion, session management, logout, reset and confirmed deletion using the local outbox; device bookmarks remain isolated when switching accounts.
- Owner-session browser regression: real layout/assets, pagination, comments, full galleries, approximate markers, map zoom/unmount cycles, seasonal trails and admin edit/hide/show.

QA commands (never against the ordinary or production database):

```sh
node scripts/setup-auth-qa.mjs
npm run build
node --env-file=.winnigo/p3-qa.env scripts/node-app.mjs start
# Another terminal:
node --env-file=.winnigo/p3-qa.env scripts/check-p3-http.mjs
WINNIGO_AUTH_MODE=session WINNIGO_CHECK_ORIGIN=http://127.0.0.1:5193 npm run check:assets
python3 scripts/check-auth-browser.py
python3 scripts/check-browser.py --origin http://127.0.0.1:5193 --mode session --evidence .winnigo/p3-evidence/discovery
```

The browser scripts need Selenium and Chrome. QA setup creates `<database>_p3_qa` and a separate S3 prefix. HTTP QA creates synthetic accounts and resets only that QA database's owner role/rate buckets. Private QA mail/session files and screenshots stay under ignored `.winnigo`. Real Google sign-in and external SMTP remain unverified until provider credentials are supplied; public signup is still closed.
