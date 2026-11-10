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
image bytes. Parser clocks come from structured times in the saved outputs. Some older parser
results put times in display text, which this score does not treat as structured timing.

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
