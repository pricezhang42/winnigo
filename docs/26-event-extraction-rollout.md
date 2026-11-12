# Event extraction rollout

Step 7 of Epic #33. Extraction is enabled per source, in stages, after the
[pilot](25-event-extraction-pilot.md). Every source starts in **shadow mode**: the collector and
its parser still own the listings, and extraction only records how its result compares.

## Modes

| Mode | Listings come from | Extraction does |
| --- | --- | --- |
| off (default) | Parser | Nothing; no provider calls |
| `shadow` | Parser | Extracts the event pages the collector already fetched, maps them with the shared importer and records a comparison |
| write (not yet available) | Extraction, with the parser as fallback | To be added after shadow results for a source have been reviewed |

## Enable shadow mode

Set these in `.env.local` (or the worker's environment) and restart the worker:

```sh
WINNIGO_EXTRACTION_PROVIDER=openai
OPENAI_API_KEY=...
WINNIGO_EXTRACTION_MODEL=gpt-6-luna
WINNIGO_EXTRACTION_INPUT_USD_PER_MILLION=0.10
WINNIGO_EXTRACTION_OUTPUT_USD_PER_MILLION=0.50
WINNIGO_EXTRACTION_RUN_BUDGET_USD=0.05
WINNIGO_EXTRACTION_SOURCES=manitoba-museum=shadow
```

The worker validates `WINNIGO_EXTRACTION_SOURCES` at startup and exits on an unknown source or
mode, or when the provider is disabled. It logs the sources in shadow mode. Enabling a source
does not change schedules: shadow comparisons run whenever that source is collected (manual
refresh, or its schedule when `WINNIGO_SCHEDULES=enabled`).

Each run gets its own service, so `WINNIGO_EXTRACTION_RUN_BUDGET_USD` caps spending per source
run. `WINNIGO_EXTRACTION_SHADOW_MAX_MS` (default 180000) bounds the time spent after the
parser's listings are saved; pages not reached are recorded as `skipped`. Unchanged pages reuse
the [cache](24-event-extraction-cache.md) and cost nothing on later runs.

## What a run records

After the parser's listings are saved, each captured page is prepared, extracted (two at a time)
and mapped without existing listings, so the candidate reflects extraction alone. The candidate
is compared with the parser listings produced from the same page:

- title and venue (case and whitespace insensitive);
- occurrence slots: timestamps, or dates for date-only sessions (split sessions from one page
  are compared together). Extracted sessions the parser lacks, or no shared session at all, are
  a difference. A detail page that lists fewer sessions than the parser found is coverage, not a
  difference: the Museum parser adds every showtime from its month calendars, while a detail
  page names only its focused date. The row records both counts (`occurrences`,
  `parserOccurrences`);
- run dates (start, end, closing month);
- price, when extraction found an amount.

Each page becomes one row in `event_extraction_comparisons` with outcome `agree`, `differ`,
`withheld` (the importer held it, for example `source-facts-need-review`), `failed`
(preparation or provider error) or `skipped` (time limit or budget). `differ` and `withheld`
rows also keep the validated model output (`raw`), so the cause of a difference can be checked;
agreeing rows do not. The run's counts gain an
`extraction` summary, and its notes say, for example, `Extraction shadow: 8/10 page(s) agree,
1 differ, 1 withheld`. Extraction trouble is noted but never fails or retries a collection.

Review the results:

```sh
npm run extraction:shadow-report -- manitoba-museum --days=14 --details
```

The report lists outcomes, the most common reasons, cost and cache hits, and with `--details`
the latest differing, withheld or failed page, each field difference, and the model's schedule
facts (without quotes) and review reasons. A difference is not
automatically a model error: check the source page, since the pilot found the parser wrong more
often than the model (143/176 versus 171/176 exact date, time and venue checks).

## Add a source

1. In the collector, after parsing an event detail page, call
   `options.onEventPage?.({ url, html, selector, exclude, id, itemIds })` with the page HTML that
   was already fetched (never fetch it again), the region selector used in the pilot, the parent
   listing id and the ids of every listing the parser produced from the page (after
   normalization, that is the `seriesId` when present). Only public event pages qualify.
2. Add the source id to `EXTRACTION_PAGE_SOURCES` in `lib/server/extraction-rollout.mjs`.
3. Run `npm test`, `npm run check:event-extraction` and the source's own checks, then enable
   shadow mode locally and review the report before enabling it anywhere else.

The Manitoba Museum and WAG collectors are wired. Tourism Winnipeg (the largest pilot gain)
follows once its collector is merged.

For WAG, set `WINNIGO_EXTRACTION_SOURCES=wag=shadow` together with
`WINNIGO_FLARESOLVERR_URL=http://127.0.0.1:8191` and the provider settings above.
The existing manual worker collection reuses each FlareSolverr detail response for shadow
extraction, without a second fetch or storing browser cookies. Multi-date grouping pages are
excluded; their individual class pages are captured. Parser-rejected detail pages are also
captured so comparisons can expose missing listings. WAG remains manual-only.
`npm run collect:wag` is still a parser-only dry run; use the worker's manual collection
(`npm run collect:wag -- --enqueue`) to record shadow comparisons, then
`npm run extraction:shadow-report -- wag --details`. The queued run still saves parser listings.
See [WAG setup](sources/wag.md) for transport limits and photo configuration.

## Toward write mode

Write mode needs, per source: a review of shadow comparisons over at least one full collection
cycle, agreement on how a difference is resolved (extraction, parser or review), and the
importer's identity checks against known listings (`ambiguous-event-identity`,
`existing-cancelled-event`), which shadow mode deliberately skips. Until then, listings,
schedules and the production audience are unchanged.

## WAG live check (November 12, 2026)

Three targeted detail pages were retrieved through the existing FlareSolverr transport and
compared with live GPT-6 Luna extraction in a disposable PostgreSQL schema. This checks the
transport-to-shadow path, not full calendar coverage. A repeat comparison used three cache
hits and no additional model cost. No application listings were changed.

- **Nourish:** extracted November 19, 6–9pm and three artwork images. The shadow report marks
  differences because the parser includes the subtitle, uses the overall WAG venue and stores
  a date rather than the extracted timestamp (midnight UTC is 6pm Winnipeg on November 19).
- **Canada Life:** held for review because November 15 conflicts with “second Sunday.”
- **Graphic Novel 3:** held because the selected event content does not state a venue. The
  model found the range, time and October 11 closure, but emitted weekday 6 for Sunday where
  the contract requires 0. A schema-valid response is not proof of factual accuracy.

The final three-page call cost an estimated US$0.001854 using the configured rates. Earlier
selector trials plus the final run totalled US$0.005674. WAG remains shadow-only; venue context,
weekday accuracy and comparisons between date-only and timed listings need review before any
write rollout.

## Missing venue fallback

Venue-based sources explicitly configure `defaultVenue` in `lib/connectors.mjs`: WAG,
Manitoba Museum, FortWhyte Alive, Canada Life Centre, The Forks and Assiniboine Park. When
extraction has no venue, the importer uses the organization's location after checking for an
existing saved venue. Stated venues and online events take precedence. Known source addresses
are included only when applying this fallback, not attached to a different stated venue.

This is an owner-authorized source default, applied after model validation and recorded as
`extraction.venueFallback = "source-location"`; it is not fabricated source evidence. Tourism
and other aggregators have no default, so missing venues remain withheld. New venue-based
sources must opt in explicitly rather than falling back to every organization's name.

Replaying the saved Graphic Novel result with this policy produces a candidate at WAG–Qaumajuq,
300 Memorial Boulevard, Winnipeg. This resolves the missing-venue hold only; the recorded
weekday error remains a separate extraction issue. No model request or listing import is
needed to verify the fallback.

## Main event times and explicit schedule precedence

The extraction prompt treats tours, workshops, doors opening and dinner service within the
main event's attendance window as activities, not additional occurrences. Explicitly offered
separate sessions of the main event still count separately. Supplied correction notices take
precedence, followed by explicitly printed event dates/times over conflicting general
recurrence rules. Two disagreeing explicit dates/times still require review unless one is
identified as a correction.

A live Luna retest on four saved WAG detail pages returned Canada Life as one November 15,
11am–5pm event, without extra tour sessions or a conflict hold. Both Graphic Novel classes
retained their correct weekly rules and closures; Nourish retained one 6–9pm event window.
The calendar correction notice was not part of those saved detail inputs: the Canada Life
result followed the printed November 15 date instead of deriving a date from “second Sunday.”
The model leaves unprinted years null; the existing importer applies the current-year policy.
The four-page pass cost an estimated US$0.002284 and the repeat used four cache hits. This
changes shadow extraction only; the legacy parser still withholds Canada Life and no app
listings were imported.
