# 04 — Sources & connectors

This covers how venue calendars, the free-swim schedule, and official trails become listings. The
Facebook collector is separate — see [05](05-social-collector.md).

## The source registry

[`lib/connectors.mjs:2`](../lib/connectors.mjs) defines the venue `sources` array:

| id | Name | URL | Parser |
| --- | --- | --- | --- |
| `winnipeg-free-swim` | City of Winnipeg · Free swim | winnipeg.ca/…/free-swim | `parseFreeSwim` + `applyPoolClosures` ([`lib/free-swim.mjs`](../lib/free-swim.mjs)) |
| `forks` | The Forks | theforks.com/events/calendar-of-events | `parseSource('forks')` |
| `park` | Assiniboine Park | assiniboinepark.ca/events | `parseSource('park')` |
| `attractions` | The Forks · places | theforks.com/attractions | `parsePlaces` |
| `manitoba` | Travel Manitoba | travelmanitoba.com/events | `parseSource('manitoba')` (Winnipeg-only) |

`trails-manitoba` is **not** in this array — it is imported offline (below) and only seeded/upserted
in `initialize()`.

## Parsing ([`lib/connectors.mjs`](../lib/connectors.mjs))

- `collectSourcePages(source, checkedAt)` — fetches HTML with a `Winnigo/1.0` UA, a 12 s timeout and
  a 2 MB size cap per page, follows each source's own pagination (The Forks: next two month lists;
  Assiniboine Park and Travel Manitoba: `?page=N` while linked, up to 5 and 6 pages) one second
  apart, and merges listings by URL. Free swim fetches **two** pages (schedule + indoor-pool
  directory) and applies closures. `collectSource` returns just the listings. Parser regression
  tests run against saved pages in `scripts/fixtures/pages` (see [17](17-p5-collection.md)).
- `parseSource(id, html, checkedAt)` — regex-based extraction per source. Each entry is normalized
  into the listing shape, given a deterministic id, categorized heuristically (`category()`), and
  de-duplicated by URL within the source.
- `parsePlaces(html)` — extracts year-round Forks attractions; filters out a hardcoded exclusion
  list; marks currently-closed places `hidden`.
- `clean(s)` — strips tags and decodes a fixed set of HTML entities. **All source text is treated as
  plain text** — never rendered as HTML.
- `localDay(now)` — current Winnipeg calendar day (`en-CA`, `America/Winnipeg`). Used everywhere for
  "today" comparisons and year inference on month/day-only dates.
- `dedupe(items)` — cross-source dedupe by normalized `title|start|venue` (plus `time` for free
  swim), with a couple of special-cased typo/name normalizations.

⚠️ **These parsers are brittle by nature** — they depend on the exact HTML structure of external
sites. When a site changes layout, the parser throws, the source is marked `error`, and the last
good listings are retained. Fixing a broken source usually means updating a regex in
`connectors.mjs` or `free-swim.mjs`. Confirm with a live run and the snapshot script (below).

## Free swim specifics ([`lib/free-swim.mjs`](../lib/free-swim.mjs))

- Parses per-pool cards → an effective date range → weekday/time slots, then **expands** each slot
  into individual dated `Event` listings within the published window only.
- Distinguishes "Free swim" vs "Free youth swim (ages 9–19)"; retains limited-pool notes.
- `applyPoolClosures()` cross-checks the indoor-pool directory; sessions during a reported facility
  closure are marked `cancelled`.
- Both pages must parse successfully before the stored collection is refreshed.
- This is the **one** source where removed items are cancelled on refresh: `refreshSources()` runs
  a special `json_set(...'$.status','cancelled')` for `winnipeg-free-swim` ids no longer present
  ([`lib/store.ts:29`](../lib/store.ts)).

## Refresh & storage ([`lib/store.ts`](../lib/store.ts))

- `initialize()` — seeds social listings, base listings + source reports, and re-imports official
  trails when `official-trails.json`'s `checkedAt` changed. All upserts preserve overrides.
- `refreshSources(force=false)` — per source: conditionally claim `attempted_at` (6 h normal,
  60 s when forced) as a lock; if claimed, fetch+parse+upsert and mark `ok`/`error`. Concurrency-safe
  because the lock is a conditional UPDATE.
- `getCollection(admin=false)` — merges override/hidden, adds derived `collection` + `mapLocation`,
  filters (non-admin hides hidden/cancelled/past), dedupes (non-admin only), sorts by start+title,
  then interleaves sources for feed variety. Also assembles the `sources` + `communitySources`
  reports and a `notice` string when any source errored.

## Official trails import ([`scripts/import-official-trails.py`](../scripts/import-official-trails.py))

- Offline Python script. Downloads the public KML exports of the Trails Manitoba **Summer** and
  **Winter** Google "My Maps", merges per-trail info across seasons, and writes
  `lib/data/official-trails.json` (556 trails). Also feeds the anchor points in
  `trail-map-anchors.json`.
- Re-import is idempotent in `initialize()` via the `source.checkedAt` guard, upserting in batches
  of 40 while preserving overrides/hidden.

## Regenerating the committed snapshots ([`scripts/import-snapshot.mjs`](../scripts/import-snapshot.mjs))

Run this to refresh the fallback `listings.json` / `sources.json` from live sites:

```bash
node scripts/import-snapshot.mjs
# or, to parse previously saved /tmp/<source-id>.html pages instead of fetching live:
node scripts/import-snapshot.mjs --from-files
```

It throws if any source yields zero listings (a signal the parser is broken — inspect before
committing a bad snapshot).

## Tests

- [`scripts/tests/connectors.test.mjs`](../scripts/tests/connectors.test.mjs) — parser/normalization
  tests (local dates, year boundaries, recurrence, duplicates, closed places, changed layouts).
- [`scripts/tests/free-swim.test.mjs`](../scripts/tests/free-swim.test.mjs) — free-swim parsing.

Run with:

```bash
node --test scripts/tests/*.test.mjs
npx tsc --noEmit   # type check
```
