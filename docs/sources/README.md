# Event source candidates

`candidates.csv` tracks public event sources under research, before any connector exists. It is not the runtime registry: the `sources` table and `lib/connectors.mjs` (see `docs/04-sources-and-connectors.md`) stay authoritative for live sources.

Record public facts only: URLs, feed types and policy notes. No scraped content, contact details or secrets.

## Columns

| Column | Values / notes |
| --- | --- |
| `id` | Stable slug that becomes `sources.id` (e.g. `wpl-events`). Once `status=live` it must equal the real `sources.id`. |
| `name` | Display name |
| `category` | `library`, `festival`, `theatre-music`, `sport`, `city-rec`, `hobby-science`, `directory` |
| `kind` | `venue`, `umbrella-directory`, `aggregator` |
| `events_url` | Event listing page (equivalent of `url` in `sources`) |
| `feed_type` | `ics`, `jsonld`, `rss`, `html`, `api` |
| `feed_url` | Only when it differs from `events_url` |
| `pagination` | `none`, `?page=N`, `month-nav`, `load-more`, ... |
| `robots_ok` | `yes`, `no`, `partial`, `unchecked` |
| `terms_note` | One line on reuse terms, with a link |
| `est_listings` | Rough count of current listings; summed toward the ~100 launch target |
| `status` | `candidate` -> `approved` -> `building` -> `live`, or `rejected` |
| `priority` | `1`-`3` |
| `notes` | Anything else, including why a source was rejected |
| `checked_at` | ISO date of the last manual check |

## Conventions

- Umbrella directories (Manitoba Historical Society, Creative Manitoba, Sport Manitoba) use `kind=umbrella-directory`; they may overlap venue sources, which matters for dedupe.
- Add a row to `docs/04-sources-and-connectors.md` only when the connector ships.
- Use `unchecked` for `robots_ok` rather than guessing.
- Quote fields containing commas.
