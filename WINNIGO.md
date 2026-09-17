# Winnigo

A private first release for discovering Winnipeg events, places and activities.

## Working features

- Four source adapters across three organizations: The Forks event calendar, The Forks attractions, Assiniboine Park, and Travel Manitoba (Winnipeg only).
- Date/category/neighbourhood filters, search, details, original-source links, directions, and device-local bookmarks.
- D1 collection storage, import status, bounded source fetching, a six-hour refresh-on-visit interval and manual refresh.
- A private collection desk at `/admin` for corrections and hiding duplicates/cancellations. Corrections survive imports.
- Parser tests for local dates, year boundaries, recurrence, duplicate handling, closed places, and changed source layouts.

## Operation

`npm run dev` starts local development. The Sites build/publish workflow packages the Worker and Drizzle migrations. `node --test scripts/tests/connectors.test.mjs` tests data normalization. `npx tsc --noEmit` checks TypeScript.

Authoritative imported records and source states live in D1; JSON snapshots supply the initial collection and clearly labeled degraded fallback. Initial seed inserts never overwrite operator corrections. Imported source content is treated as plain text, never executable HTML. Source URLs come from fixed connector hosts.

## Current scope and limitations

This is owner-private. Admin routes require platform-provided authenticated identity and currently rely on the site's owner-only audience. Before any public/shared launch, add an explicit administrator allowlist; do not expose the current admin APIs to an expanded audience.

Refreshes run on visits (every six hours) or by the owner's manual action. There is no unattended cron schedule yet. Source layout changes and upstream blocks retain the last successful collection and report an error. An absent listing is not automatically declared cancelled because calendars paginate; operators can hide cancellations. Exact duplicate titles/dates/normalized venues merge conservatively; review uncertain duplicates manually.

Multi-date series are excluded from Today/This weekend unless exact occurrences are known. Place hours, prices and accessibility are not guessed. Some labels/categories are heuristic and need editorial review. Coverage is limited to the current calendar pages and a selection of year-round Forks places, below the proposed 100-listing launch target. Place discovery beyond The Forks, more sources, official feed agreements, confirmed occurrence expansion, and richer descriptions remain rollout work.

Photos are displayed from original venue/tourism sources, credited in the UI; no open photo reuse licenses were found. Resolve permission for images and collection feeds before a broad public launch. Listings use factual titles, dates and locations with original-source links and minimal descriptions.

Bookings and payments remain on organizer sites. Bookmarks live only on the visitor's device and are not synced between browsers.
