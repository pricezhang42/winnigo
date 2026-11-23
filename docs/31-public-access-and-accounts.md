# Public access and accounts

Plan, 2026-11-23. Visitors can browse Winnigo without signing in, anyone can create an account,
and an account keeps its saved items across devices. Sign-in is Google or email and password.
This builds on the P3 accounts ([16](16-p3-accounts.md)), which already provide invitation-only
Better Auth accounts, verified email, password reset, Google sign-in, session management,
account deletion, roles and grants. Those have never been tested with real email or Google.

## Decisions

| Question | Decision |
| --- | --- |
| Who can create an account | Anyone, with a verified email. The single owner is still promoted only by the operator command (`accounts:manage -- bootstrap-owner`), never by signing up first. |
| Browsing without an account | Allowed for public discoveries: events, places and official trails. Facebook community highlights and anything restricted stay hidden from visitors, as they are from ordinary users without a grant. |
| Sign-in methods | Google, and email and password. Both already exist. |
| What an account gives | Saved items stored in the account, on every device, with a one-time import of what this browser already saved. Preferences and personalised ranking stay in P4 (#8). |
| Photos for visitors | Shown. Visitors see event and place photos like signed-in users; community photos stay restricted. |
| CAPTCHA | None at first. Email verification, rate limits and cleanup of unverified accounts carry the load; a CAPTCHA can be added if automated sign-ups appear. |
| Users panel | Part of this plan (step 2). |
| Launch | Public browsing and open sign-up ship behind settings that default to off. Turning them on for real users is part of the production cutover (P8, #10), together with the hosting, email provider and Google app review. Nothing here changes the production audience, the original site or its collector. |

AGENTS.md currently says "Never open registration". Step 2 changes it to: registration opens
only when `WINNIGO_SIGNUP=open` is set deliberately; never bootstrap the first signup as owner.

## Access after this plan

| Who | Can |
| --- | --- |
| Visitor (no account) | Browse and search public discoveries, open details, see their photos and dates. Cannot save items, see community highlights or reach the account or admin pages. |
| User | Everything a visitor can, plus saved items, sessions and account settings, and any source or listing the owner grants. |
| Admin | Collection management, as today. |
| Owner | Everything, as today. |

Local development keeps `WINNIGO_AUTH_MODE=local` (password-free owner on loopback), as
AGENTS.md requires. Basic mode is unchanged.

## Steps

Each step is one PR with its own checks.

### 1. Public browsing

Done on 2026-11-23 (`WINNIGO_PUBLIC_BROWSING`, `readerFromHeaders` and the visitor rule in
`accessClause`). Verified with `check:p3`, the HTTP check with the setting on and off, and a
signed-out browser session.

- New setting `WINNIGO_PUBLIC_BROWSING=enabled` (default off). With it, the access gate
  (`proxy.ts`) lets anonymous requests reach the home page and the read-only discovery routes:
  `GET /api/listings`, `/api/listings/:id`, `/api/listings/:id/availability` and
  `/api/photos/:id`. Admin, account, review and import routes still require the right role.
- Anonymous requests carry a visitor principal with no account. `accessClause` gives visitors
  `visibility = 'public'` rows only; source and listing grants never apply to them. The photo
  route serves a visitor only a photo of a public, current listing or event.
- The page shows "Sign in" instead of the account menu. The save button asks a visitor to sign
  in. Community sources are not listed to visitors.
- Pages send `X-Robots-Tag: noindex` until launch, so a test deployment is not indexed.
- Anonymous reads are rate-limited per client at the ingress (P8). The app-level shared limit
  stays as a backstop.
- Checks: `check:p3` gains visitor cases (public rows only, no restricted rows, photos, facets
  or source counts; no admin or account access). The browser check runs once signed out.

### 2. Open sign-up

Done on 2026-11-23 (`WINNIGO_SIGNUP`, `lib/server/users.mjs`, `/api/users`, the Users panel,
`/privacy` and `/terms`). The privacy policy and terms are drafts marked as such on the pages;
`WINNIGO_CONTACT_EMAIL` supplies their contact address.

- New setting `WINNIGO_SIGNUP=open` (default `invitation`). When open, the registration hook
  skips the invitation check; email verification is still required before the first sign-in,
  and an unverified account cannot sign in or save.
- The login page gets "Create an account" next to "Sign in", and "Continue with Google" creates
  an account for a verified Google email. Accounts are not linked across providers
  automatically, as today.
- Abuse protection: the existing per-email and global auth limits, and `accounts:cleanup`
  removes accounts left unverified for seven days. No CAPTCHA at first; Better Auth's captcha
  plugin can be added later if automated sign-ups appear.
- New pages: privacy policy and terms. Public sign-up needs them, and Google requires their
  URLs on its consent screen. The text is yours to approve; the plan provides a draft covering
  what is stored (email, name, saved items, sessions), deletion and contact.
- Owner-only "Users" panel in the admin page: list accounts with role, verification and last
  sign-in; disable or re-enable; change role. The operator commands stay for owner bootstrap and
  transfer.
- AGENTS.md and docs 16 updated as above.
- Checks: `check:p3` gains open sign-up (no invitation, verification required, cleanup of
  unverified accounts) and the Users panel's actions, and confirms invitation mode is unchanged.

### 3. Saved items in the account

Done on 2026-11-23 (`0003_saved_items.sql`, `lib/server/saved-items.mjs`, `/api/me/saved`). An
account keeps up to 1,000 saved items; the Saved tab reads them on the server, so there is no
longer a limit of 200 in the request. Verified with `check:p3`, the HTTP check in three setups
and a browser session (sign-up, verification, sign-in, import of an earlier browser list, save
and unsave).

- Migration `0003_saved_items.sql`: `saved_items(user_id → auth_user ON DELETE CASCADE,
  item_id, saved_at, PRIMARY KEY(user_id, item_id))`. An item is a listing or an event ID;
  saving checks that the user can see it. A saved item that later disappears stays saved and is
  shown as "no longer listed" rather than silently dropped.
- API: `GET /api/me/saved`, `PUT /api/me/saved/:id`, `DELETE /api/me/saved/:id` (signed-in,
  same-origin, rate-limited). The Saved tab reads the account's list through the existing search
  filter.
- `useSavedListings` reads and writes the account. After signing in on a browser that has items
  saved under the old browser key, the user is offered "Add the N items saved in this browser to
  your account" once; nothing is imported without that choice.
- Local and Basic owner modes keep browser storage (that owner has no account row).
- Account deletion removes saved items; the deletion test covers it.
- Checks: `check:p3` (isolation between users, cascade on deletion, refusal of items the user
  cannot see); a browser check for saving on one browser profile and seeing it on another.

### 4. Real providers (#6)

- Choose a transactional email provider (for example Postmark, Amazon SES or Resend) and set
  `WINNIGO_MAIL_MODE=smtp` and `SMTP_*`; set up the sending domain (SPF, DKIM, DMARC).
- Create the Google OAuth client with the callback `https://HOST/api/auth/callback/google`, the
  consent screen (app name, home page, privacy policy and terms URLs) and the `email` and
  `profile` scopes only. With only those basic scopes the app needs no security review; in
  Google's "Testing" status only listed test users can sign in, so publish it ("In production")
  before launch. Showing a logo on the consent screen adds a short brand review.
- Run `npm run accounts:check-providers -- you@example.com` on the test host: it sends a test
  email through the configured provider and prints the exact Google redirect URI and consent
  screen links to register. Then run the account acceptance against the real providers
  (verification and reset emails arrive; Google sign-up and sign-in work) and close #6.

This step needs your accounts with the email provider and Google Cloud; nothing is created or
paid for without you.

## Not in this plan

- Turning the settings on in production, hosting and backups (P8, #10).
- Preferences, onboarding and personalised ranking (P4, #8).
- Apple sign-in, emailed sign-in links, two-factor authentication.
- Opening community highlights to visitors or users without a grant.

## Risks

- Open sign-up attracts automated accounts; verification, rate limits and cleanup limit the
  damage, and accounts get nothing a visitor cannot see except saved items. Without a CAPTCHA,
  watch sign-up volume after launch.
- Visitors see copies of the sources' images and summaries of their pages; the sources' terms of
  use have not been checked for public display. Review them before launch.
- Public reads raise load on PostgreSQL; the faster discovery query (about 90 ms) helps, and the
  ingress limit is needed before launch.
- The shared auth rate limit can throttle real users at once until per-client limits exist at the
  ingress.
- Account deletion cannot erase copies already in backups; P8 sets the backup retention.
