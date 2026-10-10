# Event source tracker

`candidates.csv` lists every source Winnigo collects (`status=live`) and every source under
research. It tracks research and progress; it is not the runtime registry. Live sources are defined
in code (`lib/connectors.mjs`, `lib/data/official-trails.json`, `lib/social.mjs`; see
[docs/04](../04-sources-and-connectors.md)), and
[`source-tracker.test.mjs`](../../scripts/tests/source-tracker.test.mjs) fails if the `live` rows and
those sources disagree, or if a value below is not allowed.

Record public facts only: URLs, feed types and policy notes. No scraped content, contact details or
secrets. Open it in any spreadsheet app; keep the column order and quote fields containing commas.

## Columns

| Column         | Values / notes                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | Lower-case slug (`wpl-events`). Becomes the source ID; once `status=live` it must equal the ID in code.                                         |
| `name`         | Display name                                                                                                                                  |
| `category`     | `attraction`, `tourism`, `community`, `outdoors`, `library`, `festival`, `theatre-music`, `sport`, `city-rec`, `hobby-science`, `directory`        |
| `kind`         | `venue`, `organization`, `aggregator`, `umbrella-directory`, `community-group`, `platform`                                                     |
| `content`      | `events`, `places`, `trails`, `activities`                                                                                                     |
| `events_url`   | The page or site the listings come from (`https://`)                                                                                           |
| `feed_type`    | `ics`, `jsonld`, `rss`, `api`, `html`, `kml`, `browser` (signed-in browser), `manual` (added by link)                                          |
| `feed_url`     | Only when it differs from `events_url`                                                                                                         |
| `pagination`   | `none`, `?page=N`, `month-nav`, `load-more`, `other`                                                                                           |
| `access`       | `ok` (robots.txt and terms allow it), `limited` (only with sign-in, permission or by hand), `blocked`, `unchecked`. Details go in `notes`.        |
| `est_listings` | Whole number of current listings, or empty if unknown. Summed toward the ~100 launch target.                                                   |
| `status`       | `candidate` → `approved` → `building` → `live`, or `rejected`                                                                                   |
| `priority`     | `1`–`3` (1 = first); required for `candidate`, `approved` and `building`, empty for `live` and `rejected`                                        |
| `notes`        | Anything else, including how a source is collected or why it was rejected                                                                     |
| `checked_at`   | ISO date (`YYYY-MM-DD`) of the last check of the source                                                                                         |

## Conventions

- Use `unchecked` for `access` rather than guessing; check `robots.txt` and the terms before
  `approved`.
- Umbrella directories (Manitoba Historical Society, Creative Manitoba, Sport Manitoba) use
  `kind=umbrella-directory`: they lead to other sources and may overlap them, which matters for
  duplicate events.
- When a connector ships, set the row to `live` and add the source to
  [docs/04](../04-sources-and-connectors.md); the test keeps the two in step.
