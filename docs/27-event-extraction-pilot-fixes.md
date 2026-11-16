# Pilot corrections — November 16, 2026

The pilot uses the same 50 prepared event pages and 13 non-event controls as the previous
run. It calls GPT-6 Luna with the latest shared extraction prompt; it does not fetch sources
or import listings. The pilot now defaults to a 60-second request timeout (still overridable),
without changing the worker service's timeout or adding retries.

## Changes

- Keep all published open weekdays, including ones outside a short event run. Closed weekdays
  are omitted from weekly opening hours; dated special hours remain exceptions.
- Use one source document per quote, copy the published main venue name, and use a short literal
  excerpt for online attendance instead of reconstructing text around embedded links.
- Keep independently supported facts when a date conflicts. A contradictory “Next show” notice
  is an explicit date conflict and must be reviewed, even if a general recurrence rule agrees
  with the focused session heading.
- Keep a multi-session event marked recurring when the collection window contains only one of
  its sessions. This uses the existing shared event/occurrence model.

The scorer is a small separate module so these comparisons can be tested and prior raw model
outputs can be rescored. It credits multiple explicit sessions as recurring, reports published
series bounds before a focused session date, preserves explicit nulls, and tolerates a venue's
terminal period. Other venue differences and punctuation in titles still count as misses.

## Reference corrections

Version 5 corrects one label: `museum-first-fridays-2-2` names its overall venue “The Manitoba
Museum,” not just “Manitoba Museum, Museum Galleries.” Its Venue section and general admission
to all three core attractions support this correction. The source documents are unchanged.

Version 6 adds two previously unscored DOME@HOME checks: its disputed date must be unknown and
its schedule must require review. This raises the reference from 176 to 177 core checks and
from 321 to 323 total checks. An intermediate run matched all 321 version-5 fields but missed
this unscored conflict; it is not the final acceptance result.

The final report also scores the same outputs with the original version-4 reference and scorer,
so reference/scorer corrections can be distinguished from model improvements. Previous outputs
are rescored with version 6 for the same reason. All intermediate reports remain available;
individual case retries are not substituted into the final full-run score.

## Results

The final complete pass returned 50/50 event results, 0/13 non-event false positives, and no
API/structural-validation failures. No individual retry results replace its outputs.

| Comparison | Previous outputs | Final outputs |
| --- | ---: | ---: |
| Original v4 scorer/reference: core | 167/176 (94.9%) | 173/176 (98.3%) |
| Original v4 scorer/reference: all fields | 305/321 | 317/321 |
| Corrected scorer/v6 reference: core | 171/177 (96.6%) | 176/177 (99.4%) |
| Corrected scorer/v6 reference: all fields | 311/323 | 322/323 |

The **one remaining scored miss** is DOME@HOME's end time: the reference expects 20:00,
while the model leaves it unknown after withholding the disputed focused date. Its 19:00
monthly starting time, online attendance, recurrence and review status are retained. The
focused header's end time was not transferred to the repeating rule. This remains a miss;
it is not relabeled as correct or removed from the denominator. The shared importer withholds
the event and retains parser/calendar data.

Two genuine source conflicts remain held: Egoportraits has August 27 versus October 27
start dates (its agreed November 20 end is retained), and DOME@HOME has November 26 versus
“Next show: November 5.” These require source clarification or an owner decision.

The original comparison still counts its gallery-only venue label, focused-session versus
series-start choice, and explicit-session recurrence flag as misses. The corrected comparison
uses the documented semantics above. Boo at the Zoo now retains Sunday opening hours and
omits closed Monday/Tuesday rows. Bison Bus Tour preserves its published venue wording.

The final run reported 317,107 input and 39,068 output tokens (including 22,679 reasoning),
with 161,634 cached input tokens. Median latency was 6.21 seconds; p90 was 11.35 seconds.
Configured cost estimate: US$0.051274 for this pass; US$0.204384 across four complete development
passes and a small diagnostic. These are configured-rate estimates, not verified invoices.

Local final artifacts are `luna-pilot-fixes-closures-20261116-report.json` and
`luna-pilot-fixes-closures-20261116-summary.json`, using `reviewed-manifest-v6.json`.

The references do not include reviewed price/availability labels. This measures the existing
field regression and explicit conflict checks, not pricing accuracy, fresh source availability
or image bytes. The pilot remains empirical; correct structure and passing examples do not
ensure a future model response is accurate. Parser fallback, review holds, trusted calendar
sessions and owner overrides remain necessary.

## Verification and evidence

183 unit tests, typecheck/build, extraction/PostgreSQL/private-media integration, P2/P5 checks,
dev/built asset checks and the seeded QA browser regression pass. Regression coverage includes
month clipping with a retained recurring label, series-bound scoring, null dates, and meaningful
venue differences. Existing lint warnings remain; there are no lint errors.

Prepared contexts, manifests, raw outputs and summaries remain in the ignored local
`.winnigo/extraction-pilot/` folder. No production destinations, audiences or schedules change.
