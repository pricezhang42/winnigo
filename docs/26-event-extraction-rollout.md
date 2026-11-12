# Event extraction rollout

Step 7 of Epic #33. Extraction is enabled per source, in stages, after the
[pilot](25-event-extraction-pilot.md). Every source starts in **shadow mode**. WAG can opt into write mode after review.

## Modes

| Mode | Listings come from | Extraction does |
| --- | --- | --- |
| off (default) | Parser | Nothing; no provider calls |
| `shadow` | Parser | Extracts the event pages the collector already fetched, maps them with the shared importer and records a comparison |
| `write` (WAG only) | Accepted extraction per page, otherwise parser | Checks existing identity/state, preserves collector media, records comparisons, imports through the normal repository |

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
`npm run extraction:shadow-report -- wag --details`. In shadow mode the queued run saves parser listings.
See [WAG setup](sources/wag.md) for transport limits and photo configuration.

## Gates for further write rollout

Before enabling write mode for additional sources, review shadow comparisons over at least one
full collection cycle, agree how differences are resolved (extraction, parser or review), and test the
importer's identity checks against known listings (`ambiguous-event-identity`,
`existing-cancelled-event`), which shadow mode deliberately skips. Only WAG is currently supported for opt-in writes. Other sources remain off or shadow-only.

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

## Five-page review with explicit-date precedence

The November 12 review at `18e9d66` used saved FlareSolverr responses and fresh GPT-6 Luna
extraction. All five pages mapped successfully, producing 15 November/December occurrences:

| Page | Reviewed result | Occurrences |
| --- | --- | --- |
| Nourish | November 19, 6–9pm; dinner service is not another occurrence; three supplied artwork links | 1 |
| Canada Life | Explicit November 15, 11am–5pm, free admission takes precedence over “second Sunday” | 1 |
| Graphic Novel 3 | Sundays, September 20–November 29, 2–3:30pm; October 11 closure; WAG venue fallback | 5 |
| Graphic Novel 4 | Saturdays, September 19–November 28, 2:45–4:45pm; October 10 closure; WAG venue fallback | 4 |
| Cannes Lions | All 12 published showtimes extracted; four December showtimes retained in the window; WAG venue fallback | 4 |

Assertions checked date/time values, weekday numbers, closures, venue fallback, occurrence
counts/window and supplied image URLs (maximum three). Image bytes were not downloaded.
The run cost an estimated US$0.002992 at the configured rates. A repeat used five cache hits
and no model cost. No application listings were imported. All five shadow comparisons still
reported differences: parser formatting/date-only representations and the parser's Canada Life
hold differ from the reviewed extraction. These report differences do not measure factual
accuracy. Earlier findings above describe older prompt runs; this review verifies the updated
precedence and main-attendance-window instructions. This review preceded the opt-in write implementation below.


## Opt-in WAG imports

After reviewing shadow results, use `WINNIGO_EXTRACTION_SOURCES=wag=write` with the existing
provider, budget, FlareSolverr and photo-container settings, and restart the worker. Enqueue
WAG manually as documented in [WAG setup](sources/wag.md). This saves listings to the worker's
configured database. No setting or schedule changes automatically. An unset sources setting
keeps extraction off; `wag=shadow` returns to comparison-only mode. Museum write mode is not
yet enabled because its calendars can contain sessions absent from an individual detail page.

Write mode prepares/extracts before the ordinary atomic source import. Each accepted page
replaces that page's parser listing(s). Provider errors, missing dates, review holds, budget or
time limits and unavailable collector photos retain the parser result for that page. A page
without either result leaves existing saved data intact. Setup/comparison-storage failures
retain the whole parser batch. An incomplete calendar remains a partial run even if extraction
rescues a page the parser withheld.

The shared importer checks existing identity, cancelled state, schedule consistency and stable
occurrence ids. Owner overrides remain handled by the repository. AI candidates use only
photos already stored by the collector or preserved from existing records, up to the existing
photo limit; model image URLs do not initiate additional downloads. A parser-rejected page
with new image candidates but no stored photos is withheld for a later collector retry.

Run counts include `extraction.mode=write`, `imported` (accepted page replacements) and
`fallback` (captured pages retaining parser/existing data), alongside cache, cost and comparison
counts. Imported counts describe pages, not daily occurrence cards. Comparisons are recorded
before import, so a failed database import still has diagnostic comparisons but no successful
collection run. The source remains manual-only. Enabling write mode does not retroactively
change existing records until the next collection.


The WAG queue lease is 15 minutes to cover the existing 450-second collection budget plus the
default 180-second extraction phase and database work. Keep custom extraction limits within
that lease. Write integration tests use disposable schemas and cover accepted/rejected pages,
provider and preparation failures, owner edits, stable occurrence identities, media preservation
and parser cancellation. A replay of the five reviewed WAG outputs imported 15 occurrences
twice with unchanged occurrence ids; replay photo downloads were excluded.
