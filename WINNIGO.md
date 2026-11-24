# Winnigo

Discovering Winnipeg events, places and activities: a Next.js app on Node.js with PostgreSQL and
S3-compatible storage. It is being prepared for winnigo.lpzdev.com, first as an invitation-only
test site ([docs/32](docs/32-deployment.md)). The original site and its production collection have
not been migrated.

## Development

Start with README.md and AGENTS.md; [docs/07](docs/07-development.md) has the everyday commands.
No agent-specific tools are required. The pre-P1 Cloudflare/Sites app is kept only for rollback
([legacy/cloudflare/README.md](legacy/cloudflare/README.md)).

## Working features

- **Events** by AI extraction from the source list in `config/sources.mjs`: Tourism Winnipeg,
  FortWhyte Alive, Canada Life Centre, Manitoba Museum, Manitoba Music, City of Winnipeg free
  swims, The Forks, Assiniboine Park and Travel Manitoba (Winnipeg only). WAG–Qaumajuq is blocked
  by the site and the Rotary Club is paused (its events are poster images). See
  [docs/18](docs/18-event-collection.md).
- **Places** from The Forks, and the **Official Trails** from Trails Manitoba with a trail map.
- Search, date/category/area filters, details, original-source links and directions.
- **Accounts** (session mode): invitation-only sign-up unless the owner opens it, verified email,
  Google sign-in, an account page and saved items stored in the account. The owner changes roles
  and disables accounts in the Users panel; source and listing grants are operator commands ([docs/16](docs/16-p3-accounts.md), [docs/31](docs/31-public-access-and-accounts.md)).
- **Collection desk** at `/admin`: event review after publication, corrections that survive later
  collection, hiding cancellations, run history and manual refresh.
- **Collection jobs**: a worker runs each source on its schedule (only with
  `WINNIGO_SCHEDULES=enabled`) or on a manual refresh ([docs/17](docs/17-p5-collection.md)).
- **Duplicates across sources** are shown once, with links to every source, when the sources
  agree on title, start time and venue. Uncertain pairs stay separate for review.

## Operation

Page reads never collect. Collection runs only from the worker or `npm run collect`, through a
shared fetcher with per-origin rate limits, then extraction with a per-run cost budget. A failed
page keeps its previously published events; an event missing from a successful run is marked gone,
not silently deleted. Imported content is plain text, never executable HTML, and scraped
instructions are never followed.

Visitors see nothing until the owner enables public browsing (`WINNIGO_PUBLIC_BROWSING`); search
indexing is separately off until `WINNIGO_INDEXING` is enabled.

## Current scope and limitations

- Free swims do not yet read pool closures from the indoor pool pages.
- Manitoba Museum exhibitions show no daily hours. First Fridays is too large for the extraction
  input limit. Royal MTC pages need JavaScript. Manitoba Music reads at most 150 event pages a run
  and its pages sometimes time out.
- Multi-date series are excluded from Today/This weekend unless exact sessions are known. Place
  hours, prices and accessibility are not guessed. Some categories are heuristic and need review.
- Event photos are private copies served by the app and shown to every viewer. The owner accepted
  on 2026-11-24 that the sources' terms for showing their images have not been reviewed.
- Bookings and payments stay on organizer sites.

## Social outdoor outings

Hiking and Cycling have dedicated filters. The community panel links to the Hiking Manitoba
Facebook group (810758152436911), a private members' group. Public web retrieval is blocked; access
works through a member's signed-in browser. Its posts are collected by a local Selenium collector,
run daily at 09:00 America/Winnipeg by the existing Codex automation; that scheduler stays in place
until P6. See [HIKING-COLLECTOR.md](HIKING-COLLECTOR.md). Instagram has no automatic feed.

Facebook items are Community Highlights. Private group content stays restricted to the owner and
accounts granted that source; broader publication needs a separate content review. Owners can add a
single Facebook/Instagram post at `/admin?add=social` with a summary, date, meeting place, area,
distance and difficulty. Entries are attributed to the original post, their photos are stored
privately, and useful comment summaries keep their source links. The collector checks up to 100
newest posts, upserts by post URL and preserves corrections; it depends on the local host and a
signed-in Selenium Chrome profile and does not guarantee complete coverage. The server validates
platform hostnames, HTTPS, post paths, dates, distance and category, and strips tracking
parameters. Unknown route facts stay unknown, and private author identities and contact details are
never copied.
