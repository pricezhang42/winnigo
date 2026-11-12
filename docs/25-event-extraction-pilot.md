# Event extraction comparison pilot

Issue #44, step 6 of Epic #33. The pilot compares one main event per prepared page with a
reviewed reference and a saved result from the existing parser. It writes a local report and
does not import listings or enable collection jobs.

## Reference set

- 41 archived Tourism Winnipeg event detail pages. The archives use the October 2026 Winnipeg
  window. The selection includes exhibitions, weekday schedules, multi-day markets, multiple
  showtimes, and entries that omit or defer their times. The Egoportraits case also includes
  the organizer's page because it disagrees with the tourism listing.
- Nine Manitoba Museum event detail pages from the November and December 2026 Winnipeg window.
  The selection includes planetarium sessions, a virtual program, a long exhibition and other
  recurring programs. Existing Museum results were replayed from captured public calendar and
  detail HTML. Tourism Winnipeg results use the saved collector snapshot.
- WAG's calendar and three event detail URLs returned HTTP 403. The Tourism Winnipeg sample
  includes WAG venue listings. Direct WAG coverage remains open.

The references use visible event dates, showtimes and venue names, with published structured
data as supporting evidence. For example, the exhibition end on a detail page takes priority
over a shorter calendar slice. The disputed Egoportraits start is left unknown and requires
review. Event source text was cleaned and contact lines were removed before the model run.
Raw inputs and individual outputs belong in the ignored local QA folder.

## Scoring

Score only fields in the reference. Dates use Winnipeg calendar dates, including month precision
for imprecise ends. Clock times use 24-hour local time. Text comparison normalizes Unicode and
whitespace. Photo checks look for the published cover URL among the candidates and do not check
image bytes. Parser clocks come from structured times in the saved outputs. Where an older parser
result kept a time only in display text (for example `7:00 pm` or `8 PM - Midnight`), the
version 2 rerun derives the clock from that text and marks the baseline `timeFromDisplayText`.

An API or validation failure counts as a missing usable extraction and a miss on its scored
fields. Report the overall score and the score of usable responses separately. Extra events mean
a non-event reference yielded an event. This run used event pages only, so it does not measure
that false-positive rate. Review decisions are scored only where the reference supplies one.

## Repeat the pilot

Supply a local JSON array of cases. Each case has an `id`, a prepared `context`, `expected`
reference fields, and an optional `baseline` object in the same normalized representation.
Use `expected: null` for a non-event control. An unknown reference field can be explicitly
`null`; omit a field to leave it unscored. Image references use `imageUrl` and baselines use
`imageUrls` for the source candidates.

With the opt-in extraction environment configured, run:

```sh
node --env-file=.winnigo/event-extraction-live.env \
  scripts/check-event-extraction-pilot.mjs \
  .winnigo/extraction-pilot/reviewed-manifest.json \
  .winnigo/extraction-pilot/report.json
```

Use a fresh report path for each run. The runner uses up to three requests at a time and
honors the configured generation budget. It records field agreement, missing results, usage,
latency and failure codes. Provider calls use prepared text and links rather than image bytes.

## Results

The first live run used GPT-6 Luna on all 50 reviewed pages.

| Measure | GPT-6 Luna | Existing parsers |
| --- | ---: | ---: |
| Usable event results | 17/50 | 50/50 |
| Exact date, time and venue checks across all pages | 59/176 (33.5%) | 128/176 (72.7%) |
| All scored fields across all pages | 111/321 (34.6%) | 266/321 (82.9%) |

On the 17 usable responses, GPT-6 Luna matched 59/60 date, time and venue checks. Of the
other 33 responses, 32 failed local validation and one was incomplete. The event parser
baseline also falls below the 95% reference threshold. For the Museum, one of nine model
responses was usable. For Tourism Winnipeg, 16 of 41 were usable.

The provider reported 192,571 input tokens and 92,174 output tokens, including 30,948
reasoning tokens within output. Estimated cost at uncached rates was US$0.0654. Median
end-to-end latency per page was 13.4 seconds and the 90th percentile was 17.4 seconds.

### Paired follow-up

GPT-6.1 Sol passed validation on six selected pages and matched 18 of 20 date, time and venue
checks. On those same pages, Luna matched 3 of 20 and the existing parsers matched 14 of 20.
Sol correctly flagged Egoportraits for review and preserved the Paper Trail exhibition's
month-only closing date. Its two misses were the venue label and ending time for DOME@HOME.
The Paper Trail request used a 3,500-token output allowance to fit the remaining budget.
The selection is small and intentionally includes difficult pages.

Three Luna diagnostic reruns produced two rejections. One used a quote that did not appear
verbatim in the prepared text, and one supplied “Central Time” where the contract expects an
IANA timezone. The Egoportraits rerun passed validation. The diagnostic reruns are separate
from the scores above.

The model runs and diagnostics accounted for an estimated US$0.221 under the US$0.25 cap.
The 95% rollout gate remains open. A broader Sol sample, direct WAG pages, and non-event
controls remain unmeasured.

### Version 2 contract rerun

Issue #44 simplified the model output (doc 20). The same 50 prepared pages and references
were rerun on GPT-6 Luna. Parser times kept only in display text are now credited (12 pages).

| Measure | GPT-6 Luna v2 | Existing parsers |
| --- | ---: | ---: |
| Usable event results | 50/50 | 50/50 |
| Exact date, time and venue checks across all pages | 165/176 (93.8%) | 143/176 (81.3%) |
| All scored fields across all pages | 307/321 (95.6%) | 281/321 (87.5%) |

Tourism Winnipeg matched 133/141 core checks (parsers 111/141); the Museum matched 32/35
(parsers 32/35). Misses were five start dates, two start times, one end time and end date,
two Museum venue labels, one showtime list, one recurrence flag and one weekday set. The
parser dropped two unsupported date quotes and one unsupported venue as designed.

36 of 50 results had no review reason; 14 were held. A rerun of the 14 held pages, saving
reasons, held 11. Most reasons are model-reported conflicts: printed run ranges versus
split structured ranges (3), two postal codes in a Museum address (3), a start date that
disagrees with the organizer page or ticket URL (2, including the Egoportraits reference
review) and a "next show" note (1). One hold came from an unsupported date quote. Address
conflicts concern an optional fact and should not hold an event; see issue #44.

Usage was 178,321 input and 41,405 output tokens, estimated US$0.0386, plus US$0.0126 for
the held-page rerun.

### Version 3: field-named review reasons

Model review reasons now name the fact they affect. Title, schedule and unclassified conflicts
hold an event; venue, price and link conflicts become issues. The prompt says that structured
data splitting a printed range is not a conflict. A quote may also be several excerpts on
separate lines when they all appear in the same document, such as a date and a time printed
apart. The same 50 pages were rerun on GPT-6 Luna with two non-event controls added.

| Measure | v2 | v3 |
| --- | ---: | ---: |
| Usable event results | 50/50 | 50/50 |
| Held for review | 14 | 4 |
| Exact date, time and venue checks | 165/176 (93.8%) | 167/176 (94.9%) |
| All scored fields | 307/321 | 311/321 |

All four holds are model-reported schedule conflicts: the Egoportraits start date (the reference
review), a ticket URL dated two days earlier, DOME@HOME's "next show" note, and a First Fridays
program labelled with another month. The five Museum postal-code conflicts are now issues.
Remaining misses: three start times, two end times, two dates, two venue labels and one
recurrence flag. The 95% gate needs one more correct check.

Both non-event controls, Tourism Winnipeg "Upcoming Events" listing pages, returned no event.
A third candidate was dropped: its page title said "Annual Festivals & Events" but the page is
the Culture Days detail page, which the model correctly extracted. FortWhyte month calendars
exceed the preparation limits because of their page-wide JSON-LD, so production would not send
them. Two controls cannot establish a false-positive rate.

Usage was 204,014 input and 38,930 output tokens, estimated US$0.040 per full run. Development
runs for this version (a first v3 run and a five-page quote diagnosis) cost about US$0.045.
