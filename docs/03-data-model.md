# 03 — Data model

This describes the current D1 schema. The proposed PostgreSQL model, including user accounts, preferences and bookmarks, is in [11 — Target system design](11-target-system-design.md).

## D1 tables

Defined in [`db/schema.ts`](../db/schema.ts); migration in
[`drizzle/0000_greedy_mystique.sql`](../drizzle/0000_greedy_mystique.sql).

### `listings`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | Deterministic per source (see id conventions below). |
| `source` | text | Source id (`forks`, `park`, `attractions`, `manitoba`, `winnipeg-free-swim`, `trails-manitoba`, `facebook`, `instagram`, or `social-*`). Indexed. |
| `payload` | text (JSON) | The full listing object (the "listing shape" below). |
| `hidden` | integer | `0`/`1`; owner-set. Overlays `status='hidden'` at read time. |
| `override` | text (JSON) or null | Owner corrections merged **over** the payload at read time. |

The key design idea: **`payload` is the collected/imported truth; `override` + `hidden` are the
owner's edits.** Refreshes and re-imports rewrite `payload` but never touch `override`/`hidden`, so
corrections survive. Merge happens in `getCollection()`
([`lib/store.ts:33`](../lib/store.ts)): `{...payload, ...override, status: hidden ? 'hidden' : payload.status}`.

### `sources`

Per-source collection report (one row per source id, plus a `facebook` row for the collector).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | Source id. |
| `checked_at` | text | ISO timestamp of last **successful** collection. |
| `attempted_at` | text | ISO timestamp of last attempt (used as the 6-hour refresh lock). |
| `count` | integer | Listings from the last collection. |
| `status` | text | `ok` / `error` / `pending` / `blocked` / `partial`. |
| `error` | text or null | Last error message (shown to owner only). |

## Listing "payload" shape

Not enforced by a schema — it's a plain object. The canonical TypeScript view is the `Listing`
type in [`components/winnigo.tsx:14`](../components/winnigo.tsx). Common fields:

| Field | Meaning |
| --- | --- |
| `id`, `title`, `type` | `type` ∈ `Event` / `Place` / `Activity`. |
| `category` | e.g. `Arts & culture`, `Music`, `Outdoors`, `Hiking`, `Cycling`, `Water activities`. |
| `venue`, `address`, `neighbourhood` | Location text. |
| `start`, `end` | `YYYY-MM-DD` (Winnipeg local day). Absent = evergreen/unscheduled. |
| `time` | Free-text local time. |
| `schedule` | `event` / `series` / `evergreen` / `unscheduled`. Drives Today/weekend logic. |
| `image` | Primary image URL (may be empty). |
| `images` | Array of stored `/api/photos/<hash>` paths (community posts). |
| `url` | Original source/permalink. |
| `source`, `sourceName` | Source id + display name. |
| `checkedAt` / `addedAt` | ISO timestamps. |
| `price` | `0` (free), `null` (see source), or a number. |
| `family`, `indoor` | Booleans for quick filters. |
| `description` | Short text, max 1200 chars. |
| `status` | `active` / `hidden` / `cancelled`. |
| `provenance` | `municipal` (free swim), `browser` (collector), `manual` (owner add), `official` (trails), or absent (venue calendars). |
| `distanceKm`, `difficulty` | Outdoor outings; `difficulty` ∈ `Unknown`/`Easy`/`Moderate`/`Challenging` or Trails-Manitoba levels. |
| `commentNotes` | `[{text, url}]` — paraphrased Facebook discussion notes with permalinks. |
| `facilityUrl`, `scheduleStart`, `scheduleEnd` | Free-swim extras (pool page + effective schedule window). |
| `trailVariants`, `seasons`, `activityCategories` | Official-trail extras (per-season map info). |
| `mapLocation` | Optional resolved map geometry (see below). |
| `sourceGroup`, `sourceVisibility` | Collector adds `810758152436911` / `private`. |

Derived at read time (not stored): `collection` (label) and `mapLocation`, via
[`lib/trail-locations.ts`](../lib/trail-locations.ts).

## Id conventions

- Venue calendar: `<source>-<last-url-segment>-<start>` (e.g. `forks-1311-2026-09-19`).
- Places: `place-<slugified-title>`.
- Free swim: `winnipeg-free-swim-<venue-slug>-<date>-<time-slug>`.
- Official trails: `official-<hash>` (from the KML import).
- Facebook collector: `facebook-<sha256(url)>` (canonical URL uses `https://facebook.com/`).
- Manual social: `social-<uuid>`.

## Seed / snapshot data ([`lib/data/`](../lib/data))

| File | Role |
| --- | --- |
| `listings.json` | Snapshot of venue listings — initial seed **and** degraded fallback when live fetch fails. |
| `sources.json` | Snapshot of source reports (seed + fallback). |
| `social-listings.json` | Curated social seeds (the Centennial Trail entry); seeded with `INSERT OR IGNORE`. |
| `official-trails.json` | The 556-trail Trails Manitoba import, keyed by `source.checkedAt` for idempotent re-import. |
| `trail-map.json` | Route geometry (OSM/ODbL) for the Leaflet map, keyed by trail-name `match`. |
| `trail-map-anchors.json` | Point locations from Trails Manitoba maps (no full geometry). |

These snapshots are **committed** and regenerated by scripts — see
[04 — Sources & connectors](04-sources-and-connectors.md) and [09 — File map](09-file-map.md).

## Example / unused surface

[`examples/d1/`](../examples/d1) contains a Drizzle "notes" example from the starter. It is not part
of Winnigo; keep or delete independently. `db/index.ts`'s `getDb()` (Drizzle) is likewise unused by
Winnigo, which uses raw D1 prepared statements in `lib/store.ts`.
