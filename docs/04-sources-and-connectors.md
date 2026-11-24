# 04 — Sources & connectors

How public sources become listings and events. The Facebook collector is separate — see
[05](05-social-collector.md).

| Content | Where it comes from | Stored in |
| --- | --- | --- |
| Events | The source list in [`config/sources.mjs`](../config/sources.mjs), read by AI extraction ([18 — Event collection](18-event-collection.md)) | `events`, `event_sessions` |
| Places | The Forks' places page, parsed by `parsePlaces` in [`lib/connectors.mjs`](../lib/connectors.mjs) (source `attractions`) | `listings` |
| Official trails | Trails Manitoba's public map exports (below) | `listings` |
| Community highlights | The Hiking Manitoba collector ([05](05-social-collector.md)) and posts the owner adds | `listings` (restricted) |

The hand-written event parsers (Tourism Winnipeg, FortWhyte, Canada Life Centre, Manitoba Museum,
WAG, Manitoba Music, The Forks, Assiniboine Park, Travel Manitoba, Rotary and the free-swim
schedule) were removed on 2026-11-23; see [30 — Event collection redesign](30-event-collection-redesign.md).

## Places

The worker collects `attractions` like any other source (`npm run worker`, then Refresh in the
admin page). Every place is an evergreen listing; places marked currently closed are hidden, and
unsafe seasonal entries are left out. Owner corrections and hidden flags survive later runs.
`scripts/fixtures/pages/forks-attractions.html` is the saved page the tests parse.

## Official trails import ([`scripts/import-official-trails.py`](../scripts/import-official-trails.py))

- Offline Python script. Downloads the public KML exports of the Trails Manitoba **Summer** and
  **Winter** Google "My Maps", merges per-trail info across seasons, and writes
  `lib/data/official-trails.json` (556 trails). Also feeds the anchor points in
  `trail-map-anchors.json`.
- Re-import is idempotent in `initialize()` via the `source.checkedAt` guard, upserting in batches
  of 40 while preserving overrides/hidden.
