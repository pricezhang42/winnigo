# 01 — Product overview

## What it is

**Winnigo** is a discovery app for Winnipeg, Manitoba. It aggregates:

- **Events** from public venue calendars (The Forks, Assiniboine Park, Travel Manitoba).
- **Places** — year-round attractions at The Forks.
- **Free swim sessions** from the City of Winnipeg pool schedule.
- **Official trails** imported from Trails Manitoba (556 trails, with an interactive map).
- **Community outdoor outings** (Hiking / Cycling) from a private Facebook group and manual entry.

Everything links back to its original source. Winnigo does **not** handle bookings or payments —
those stay on the organizer's site.

## Who it's for

Currently **owner-private**. The admin surface and the private-group content rely on the Site
being restricted to a single authenticated owner (see [08 — Security & privacy](08-security-privacy.md)).
It is explicitly **not ready for a public/shared launch** — that requires an admin allowlist,
content/licensing review, and broader source agreements.

## Core user experience

- A single-page discovery feed (`/`) with search, quick filters (Today, This weekend, Free,
  Family-friendly, Indoors), category filters, neighbourhood filter, and collection filters
  (All / Community Highlights / Official Trails).
- A detail dialog per listing with photos, facts, source links, directions, and — for community
  posts — discussion notes and private photo galleries.
- A **Trail map** tab: an interactive Leaflet map of hiking/cycling outings plus an embedded
  Trails Manitoba map.
- **Bookmarks** saved to `localStorage` (device-local, not synced).
- A private **collection desk** at `/admin` for refreshing sources, correcting details, hiding
  duplicates/cancellations, and adding social outings.

## How data stays fresh

- Venue calendars **refresh on visit**, at most once every 6 hours per source (owner can force a
  manual refresh, throttled to once/minute). There is no unattended cron for venue calendars.
- The Facebook group is collected by a **daily local Selenium browser run at 09:00
  America/Winnipeg**, driven by a Codex automation, not by the Worker. See
  [05 — Social & the Facebook collector](05-social-collector.md).
- Instagram has **no** automatic feed; posts are added manually by link.

## Current scope & limitations (from `WINNIGO.md`)

- Owner-private; admin APIs must not be exposed to a wider audience without an explicit allowlist.
- Coverage is below the proposed 100-listing launch target; limited to current calendar pages plus
  selected Forks places and the official trail import.
- Absence of a listing is **not** treated as cancellation (calendars paginate); the free-swim page
  is the one safe exception where removed sessions are cancelled on a successful refresh.
- Multi-date series are excluded from Today/This weekend unless exact occurrences are known.
- Hours, prices, and accessibility are not guessed; some categories are heuristic and need review.
- Photos are shown from original sources with credit; no open reuse license was secured. Resolve
  image/feed permissions before any public launch.
- Private Facebook group content must stay within the authorized (owner-only) audience.

## Key product invariants

1. Every listing links back to its original source and is attributed.
2. Imported source content is treated as **plain text, never executable HTML**.
3. Owner corrections and hidden state **survive source refreshes and re-imports**.
4. Unknown facts (dates, distance, difficulty, meeting point) stay **explicitly unknown** rather
   than being inferred.
5. A changed/blocked source retains its last good data and reports an error — it never silently
   empties the collection.
