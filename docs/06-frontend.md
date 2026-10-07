# 06 — Frontend

## Components

| File | Role |
| --- | --- |
| [`components/winnigo.tsx`](../components/winnigo.tsx) | Discovery page: filter state, tabs, search, results layout. |
| [`components/discovery/`](../components/discovery) | Pieces of the discovery page: `listing-card`, `listing-detail-dialog`, `feature-grid`, `discovery-dialogs` (area filter, sources), the `use-discovery-results` / `use-saved-listings` hooks and `listing-format` display rules. |
| [`components/admin.tsx`](../components/admin.tsx) | Owner collection desk: source status, search, edit dialog, hide/show. |
| [`components/social-outing-form.tsx`](../components/social-outing-form.tsx) | "Add social outing" form used inside the admin page. |
| [`components/trail-map.tsx`](../components/trail-map.tsx) | Leaflet map + Trails Manitoba embed + filters + list. |
| [`components/listing-gallery.tsx`](../components/listing-gallery.tsx) | Photo carousel/lightbox for a listing's `images`. |
| [`components/ui/*`](../components/ui) | shadcn/Radix primitives (Button, Dialog, Carousel, Tabs, …). Generated; mostly untouched. |

Styling is a single global stylesheet: [`app/globals.css`](../app/globals.css) (Tailwind v4 +
bespoke class names like `.app-shell`, `.listing-card`, `.trail-canvas`). Class names in the TSX map
to rules there. `components.json` configures shadcn.

## Discovery UI ([`components/winnigo.tsx`](../components/winnigo.tsx))

- Client component holding the filter state: `tab` (Explore/Events/Places/Activities/Trail
  map/Saved), `query`, `quick` filter, `category`, `area`, `collection` (All/Community
  Highlights/Official Trails), trail-map filters and `offset` (paged "Show more").
- [`use-discovery-results`](../components/discovery/use-discovery-results.ts) fetches one page of
  `GET /api/listings` whenever a filter changes (debounced, superseded requests aborted). Filtering,
  access control and paging happen on the server; a non-zero offset appends the next page. A
  1-minute `today` ticker refetches when the Winnipeg date changes.
- [`use-saved-listings`](../components/discovery/use-saved-listings.ts) keeps bookmarks in
  `localStorage` per signed-in account (`winnigo-saved-<userId>`; legacy owner modes use
  `winnigo-saved`). Server-side bookmarks are P4.
- **Detail dialog** ([`listing-detail-dialog`](../components/discovery/listing-detail-dialog.tsx))
  shows gallery or a category placeholder, facts, series/approximate-location
  notices, discussion notes (`commentNotes`), official trail variants, "Visit original listing",
  Save, and Directions (Google Maps) — Directions is suppressed when the meeting point is
  unconfirmed.
- Provenance drives presentation ([`listing-format`](../components/discovery/listing-format.ts)): `manual`/`browser`/`official`/`municipal` listings without an
  image show a Compass placeholder; community/official listings get a "collection label" chip.

## Trail map ([`components/trail-map.tsx`](../components/trail-map.tsx))

- Two tabs: **Winnigo trails** (interactive Leaflet) and **Trails Manitoba maps** (embedded Google
  My Maps iframe, summer/winter).
- Leaflet is dynamically `import()`-ed client-side; OSM tiles; tile/load errors degrade gracefully to
  the list + source maps.
- Each listing is matched to geometry via `resolveMapLocation()`
  ([`lib/trail-locations.ts`](../lib/trail-locations.ts)): explicit `mapLocation` → `trail-map.json`
  route by name `match` → `trail-map-anchors.json` point → a small hardcoded lake/park fallback
  (marked `approximate`). Unmatched outings are listed under "awaiting a location".
- Filters: distance, difficulty, season. Markers cluster by rounded position; multi-outing pins get a
  popup list. "Fit trails" refits bounds.
- Route data license is surfaced in the UI (OSM/ODbL, Manitoba Trails Project, Trails Manitoba). A
  downloadable `public/trail-map-data.json` is offered.

## Admin desk ([`components/admin.tsx`](../components/admin.tsx))

- Server page [`app/admin/page.tsx`](../app/admin/page.tsx) checks `getOwner()`
  ([`lib/auth.ts`](../lib/auth.ts)) — non-owners get an "Owner sign-in required." message. (The Worker
  gate already 401s anonymous requests site-wide before this renders.)
- Client component loads `GET /api/sources` (owner-only, returns admin collection incl. hidden), then
  issues `POST /api/sources` for `refresh` / `update` / (via the form) `add-social`.
- Shows source status cards (venue + `facebook`), a searchable listing list with per-item hide/show,
  and an edit dialog for title/description/price. Edits become **overrides** that survive refreshes.

## Notable UI conventions

- Everything is one route (`/`) with tab state — no client router navigation between views.
- Winnipeg time is the reference timezone for all date labels and "today".
- Images use `onError` fallbacks to two hardcoded Forks/Leaf images.
- Accessibility: aria labels, live regions on counts/status, keyboard-friendly gallery.
