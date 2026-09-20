# Winnigo

A private first release for discovering Winnipeg events, places and activities.

## Working features

- Source adapters include The Forks event calendar, The Forks attractions, Assiniboine Park, Travel Manitoba (Winnipeg only), and City of Winnipeg free swim schedules.
- Date/category/neighbourhood filters, search, details, original-source links, directions, and device-local bookmarks.
- D1 collection storage, import status, bounded source fetching, a six-hour refresh-on-visit interval and manual refresh.
- A private collection desk at `/admin` for corrections and hiding duplicates/cancellations. Corrections survive imports.
- Parser tests for local dates, year boundaries, recurrence, duplicate handling, closed places, and changed source layouts.

## Operation

City free swims appear under Water activities as dated, free events, expanded only within the published schedule period. Youth ages and limited-pool restrictions are retained. The indoor pool directory is checked alongside the schedule; sessions during reported facility closures are cancelled. Both pages must parse successfully before the stored collection is refreshed. Removed swim sessions are cancelled on a successful refresh; this exception is safe for the complete free-swim page and does not change paginated calendar handling. Updates follow the existing six-hour refresh-on-visit interval. Each swim links to the source schedule and its facility page. Parser checks: `node --test scripts/tests/*.test.mjs`.

`npm run dev` starts local development. The Sites build/publish workflow packages the Worker and Drizzle migrations. `node --test scripts/tests/connectors.test.mjs` tests data normalization. `npx tsc --noEmit` checks TypeScript.

Authoritative imported records and source states live in D1; JSON snapshots supply the initial collection and clearly labeled degraded fallback. Initial seed inserts never overwrite operator corrections. Imported source content is treated as plain text, never executable HTML. Source URLs come from fixed connector hosts.

## Current scope and limitations

This is owner-private. Admin routes require platform-provided authenticated identity and currently rely on the site's owner-only audience. Before any public/shared launch, add an explicit administrator allowlist; do not expose the current admin APIs to an expanded audience.

Refreshes run on visits (every six hours) or by the owner's manual action. Facebook has a separate daily browser collector described below; venue calendars have no unattended cron schedule. Source layout changes and upstream blocks retain the last successful collection and report an error. An absent listing is not automatically declared cancelled because calendars paginate; operators can hide cancellations. Exact duplicate titles/dates/normalized venues merge conservatively; review uncertain duplicates manually.

Multi-date series are excluded from Today/This weekend unless exact occurrences are known. Place hours, prices and accessibility are not guessed. Some labels/categories are heuristic and need editorial review. Coverage is limited to the current calendar pages and a selection of year-round Forks places, below the proposed 100-listing launch target. Place discovery beyond The Forks, more sources, official feed agreements, confirmed occurrence expansion, and richer descriptions remain rollout work.

Photos are displayed from original venue/tourism sources, credited in the UI; no open photo reuse licenses were found. Resolve permission for images and collection feeds before a broad public launch. Listings use factual titles, dates and locations with original-source links and minimal descriptions.

Bookings and payments remain on organizer sites. Bookmarks live only on the visitor's device and are not synced between browsers.

## Social outdoor outings

Hiking and Cycling have dedicated discovery filters. The community panel links to the user-supplied Facebook group (810758152436911). The signed-in browser verified that it is Hiking Manitoba, a private members’ group. Public web retrieval returned a block; access through the member’s browser works. Hiking Manitoba uses a local Selenium collector invoked by Codex daily at 09:00 America/Winnipeg. Instagram has no automatic feed. See HIKING-COLLECTOR.md for operation and limitations.

Owners can use `/admin?add=social` to add an individual Facebook/Instagram post URL with a summary, event date or undated activity, meeting place, area, distance and difficulty. These records are stored in D1 and attributed to the original post. Post photos are stored privately in R2 and displayed in clickable galleries. Useful comment summaries retain source links in a separate discussion section. Owner entries are marked manual; collector entries are marked browser with private group provenance. The collector checks up to 100 newest posts, upserts by source URL and preserves corrections. Check status appears in the collection desk. It depends on the local host and a separately signed-in Selenium Chrome profile, and does not guarantee complete coverage. The server validates platform hostnames, HTTPS, post paths, date ranges, distance and category, and strips tracking parameters. Unknown route facts stay unknown. Private group content must remain within an authorized audience; broader publication needs a separate content review.

The first curated social entry is Centennial Trail's public announcement for its October 4, 2026 volunteer maintenance day, discovered through Hiking Manitoba. The original public post was opened through the signed-in browser. Its title/date/start time and a short paraphrase are seeded server-side; no member profiles, private photos, contact details, or private personal narratives were copied. Meeting point, distance and difficulty remain unconfirmed. It is explicitly marked outside Winnipeg.
