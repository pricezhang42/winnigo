# Configurable AI sources

Issue #67. A configurable AI source is a settings entry instead of a hand-written parser. One
shared crawler finds the event pages and the existing extraction pipeline
([contract](20-event-extraction-contract.md), [preparation](21-event-page-preparation.md),
[cache](24-event-extraction-cache.md)) reads each page. This first stage is **review only**:
results are saved for a person to check, never published as listings, and nothing is scheduled.

## Definition

Definitions live in `AI_SOURCES` in `lib/server/ai-sources.mjs`, so code review covers each
site's fetch scope:

| Field | Meaning |
| --- | --- |
| `id`, `name` | A new slug (must not collide with an existing source) and a label |
| `allowedOrigin` | The only https origin the crawler may fetch |
| `startUrls` | One to five list pages on that origin |
| `eventLinkPattern` | Anchored pattern on path and query for event detail links |
| `listLinkPattern` | Optional anchored pattern a "next page" link must match |
| `maxListPages`, `maxEventPages` | Limits (at most 20 and 100) |
| `selector`, `exclude` | Optional content region for page preparation |
| `reference` | Optional existing source whose saved listings the candidates are compared with |

The Tourism Winnipeg test definition (`tourism-winnipeg-ai`) reads the public Upcoming Events
list, follows `display,event/<id>` links, and is compared with the hand-written
`tourism-winnipeg` parser.

## Crawler

`crawlAiSource` reads the start pages, collects links on the allowed origin that match the event
pattern, and follows one "next page" link per list page: `rel="next"`, a `next` class, or a
Next / › label. Every request goes through the shared `sourceReader`: one request per second per
origin, no redirects, a request cap of the two page limits, response size caps and a run
timeout. Off-origin links and credentials are refused. The crawler never interprets page
content; that is the model's job.

## Review mode

`runAiReview` prepares each fetched page, extracts it through the cache and the run budget, and
maps it with the shared importer without existing listings. Each page becomes one row in
`event_extraction_comparisons` (`run_id` is empty; no collection run or source report is
created):

- `candidate`: a mapped event with no reference listing for the same URL;
- `agree` / `differ`: compared with the reference listing (exact URL, or the URL without its
  last path segment, since sites often add a slug to a canonical event URL);
- `withheld`: the importer held it, for example `source-facts-need-review`;
- `skipped`: `outside-collection-window` (no dates this or next month; a crawler cannot know an
  event's dates before reading its page), or a time or budget limit;
- `failed`: preparation or provider error.

Review rows keep the model output (`raw`). Against a reference, sessions are matched by
Winnipeg local day when either side lacks a time, and run dates and price count only when the
reference has them, because a missing value there is new information, not a disagreement.
Parser shadow comparisons ([doc 26](26-event-extraction-rollout.md)) are unchanged.

```sh
npm run collect:ai -- tourism-winnipeg-ai            # crawl only: no model, no database
npm run collect:ai -- tourism-winnipeg-ai --review   # extract and save review rows
npm run extraction:shadow-report -- tourism-winnipeg-ai --details
```

`--review` needs PostgreSQL with migration `0012`, and the extraction provider settings. It
compares with the reference source's saved listings, so collect that source first.

## Tourism Winnipeg test (2026-11-18)

The crawler read 4 list pages through the site's `class="next"` link and found 36 event pages,
with no failures. In the same session the existing parser collected 209 listings for this and
next month in memory, as the reference; nothing was saved. GPT-6 Luna extracted all 36 pages
for US$0.032 in about 4 minutes.

| Outcome | Pages |
| --- | ---: |
| Agree with the parser | 15 |
| Differ | 6 |
| Withheld for review (Egoportraits date conflict) | 1 |
| Skipped, outside the collection window (later Jets, Moose and Candlelight dates) | 14 |

All 22 mapped events matched a parser listing. The six differences are all session dates:

- **Mike Green** (comedy): the page now lists November 18–19; the parser has November 17. The
  model is likely more current.
- **Storytime with a Pilot**: the page says "first Thursday of each month" but lists December
  10, a second Thursday. The model followed the rule and did not flag the conflict.
- **Worlds of Ice, Legends of the Northern Sky, Eaton's vignettes, Lexical Gaps**: the page's
  structured data publishes multi-day ranges whose first range starts on the current day. The
  model reads them as daily visiting days; the parser uses calendar cards. A person needs to
  decide which reading the site intends.

The first run also showed two comparison artifacts that are now fixed: slugged links did not
match the parser's canonical URLs, and date-only parser sessions did not match timed model
sessions on the same day.

## Limits and next steps

- The crawler reads every listed event, including ones outside the collection window; those
  cost an extraction once and are then cached.
- One event per page: pages that list several events with no detail pages need a contract
  change.
- Sites that render their list with JavaScript, or need a browser or bot-protection workaround,
  are not supported.
- Publishing from an AI source needs its own write gate: several clean review runs, a decision on
  how to resolve differences like the multi-day ranges above, and the importer's identity checks
  against known listings.
- Next candidates are small organizations with no parser, such as RASC Winnipeg Centre.
