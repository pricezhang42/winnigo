# Event extraction acceptance — November 17, 2026

The shared pipeline supports all eight HTML event sources. The original three-source evidence
for WAG, Manitoba Museum and Tourism Winnipeg is retained below; expanded HTML verification
is recorded separately at the end. Page reads never collect. Production destinations,
audience and schedules are unchanged. Extraction remains off unless a worker explicitly enables it.

## Behavior

Fetch and prepare public event content, extract one main event, validate exact supporting quotes,
normalize through the shared event/occurrence model, and save through PostgreSQL/private media.
The application owns source addresses, identity, timezone, date expansion and writes. Unconfirmed
facts remain unknown; failed extraction retains parser data and reports its outcome. Cache keys
include relevant prepared content, model and prompt/schema version; rotating email-protection URLs
are excluded from prepared facts. Cache hits still pass validation.

WAG reuses FlareSolverr HTML and individual class pages. Museum retains complete matching calendar
sessions. Tourism retains calendar visits and IDs while adding only supported same-day times.
Every fetched annual profile is reviewed, including expired editions, uncertain dates and
calendar-linked editions; only verified dates overlapping this and next Winnipeg month import.
Calendar/annual matches account for edition ranges clipped by the month window. Confirmed duplicate
productions suppress covered cards and split partial overlaps into unique visiting days. Original range IDs remain as history; derived days inherit existing owner edits without overwriting later edits.

An event-specific address can be its display location when no venue name is given. Aggregators
never inherit an organization location. Quoted price ranges stay ranges without a fixed amount
unless a named general/adult tier states that amount. A ticket label or price alone does not
prove availability. Midnight is 00:00 and its following-day offset is derived by the application.
Photos use the shared private image pipeline, with at most three images, including verified GIFs.

## Reviewed pilot

The final complete run uses the same **50 events and 13 controls**. No individual retries replace
its outputs. It returned every event, no API/structural failures, and **0/13 control false positives**.
It matched **175/177 core checks (98.9%)** and **417/423 total checks (98.6%)**. Prices matched
48/50 and availability 49/50. Configured cost estimate: US$0.052163. These are empirical results,
not a guarantee for future pages or a verified provider invoice.

The six misses are concentrated in three cases:

- Boo at the Zoo omitted a supported price and hours, and lost the first date through an unsupported
  quote. Its schedule is held; the importer retains calendar/parser data.
- Detail-only DOME@HOME retained its explicit-date conflict hold and left its end time and free
  price unknown. Fresh paired calendar/detail import confirms all three sessions, 19:00–20:00,
  Free and Online; the production workflow supplies that matching calendar context.
- PseudoScience left availability unknown despite the literal “This event has passed” notice.

The committed `scripts/fixtures/extraction-pilot-admission.json` contains only reviewed numeric
price/availability labels, not scraped pages. Original date/venue reference labels are unchanged.
One admission-label correction is explicit: PseudoScience is unavailable because of its published
passed-event notice. Its first draft label was unknown; this correction predates the final run.
The scorer accepts open weekdays represented as either visiting hours or timed weekly rules,
which the contract and mapper both permit. These scorer/reference changes are separate from
model improvement. Archived parser references did not measure admission, so those fields are
excluded from parser comparisons instead of scored as failures or assumed predictions.

The local final manifest/report are `reviewed-manifest-v8.json` and
`final-acceptance-v8-20261117.json`. Earlier complete development runs remain preserved (v7 and v7b);
their configured estimates were $0.051085 and $0.053298. Raw contexts, outputs and QA config stay
ignored and local. To reproduce with the local original v6 manifest:

```sh
node scripts/check-event-extraction-pilot.mjs \
  /private/path/reviewed-manifest-v6.json \
  /private/path/new-report.json \
  scripts/fixtures/extraction-pilot-admission.json
```

Provide the existing provider/model/token limits and an explicit budget in a private environment.
The report path must be new. API keys never belong in the manifest, report, command arguments or git.

## Final source verification

Fresh Tourism collection read all 25 calendar/directory pages and 225 detail pages, including
all 21 annual profiles. It retained 206 current source records plus one archived annual alias.
All annual profiles matched **57/57 reviewed checks**: 18 dated editions were recognized with
correct bounds; three uncertain profiles gained no invented day. Matching editions link to the
calendar record, and expired editions stay review-only.

The initial 224-page AI pass accepted 201 enrichments, retained five parser fallbacks and hit the
5,000-output-token limit on two pages. Its estimate was $0.177245. One controlled recovery used
222 cache hits and two new calls with an explicit 12,000-token/120-second allowance; both succeeded
for $0.001654. These recovery results are separate from the initial pass, not substituted into the
63-case pilot. Final source outcomes: **203 enrichments, three undated annual fallbacks, 18
review-only profiles, no failed/skipped model pages**. The final repeat used **224 cache hits,
zero paid calls/cost, 0 added / 206 unchanged**, with only collection timestamps refreshing.

The date audit retained every original ID/date and added one stable derived unique day to resolve
a partial overlap. Across current and archived records there are 207 parents and 502 occurrence
rows, including superseded history. Thirteen overlapping source ranges are suppressed with no
lost unique visiting days or remaining duplicate cards. All 203 private image objects passed
integrity checks. Two source photo 404s keep the source report partial. Chrome confirms the Leaf
range with unknown fixed price, CP Holiday Train's crossing address/time, dated exhibition cards,
Grandpa's unique December 10 card, loaded images and no severe console errors.

Fresh Museum calendar/detail QA confirms DOME@HOME on November 5, November 26 and December 31,
all 19:00–20:00, Free and Online. WAG's existing FlareSolverr transport confirms Bell Ornaments
$110 / Register Now. The current Cannes Lions page has no admission amount, so extraction leaves
it unknown. Nourish now redirects to another event path and the identity guard refuses it; its
saved November 16 response still produces $125 / No longer available with the final prompt.
That saved-response test is not a fresh Nourish verification.

217 unit tests, typecheck/build, extraction/PostgreSQL/private-media integration, P2/P5 checks,
dev/built CSS/JS checks, seeded browser regression and focused card/photo checks pass. No raw
source/model snapshots or private environment files are committed.

## Source modes and operation

| Source | Extraction mode | Authority |
| --- | --- | --- |
| WAG | opt-in shadow/write | own event/class pages, explicit source venue fallback |
| Manitoba Museum | opt-in shadow/write | matching calendars, own details, source venue fallback |
| Tourism Winnipeg | opt-in shadow/write | calendar visits and bounded annual-edition review; no organization fallback |
| Canada Life Centre, FortWhyte, free swim | native parser | structured feeds/schedules, closures and private-media rules |
| The Forks | opt-in shadow/write | printed month-calendar intervals and stable occurrence IDs; detail metadata/time refinements |
| Assiniboine Park | opt-in shadow/write | focused event details, explicit sessions and organization venue fallback |
| Travel Manitoba | opt-in shadow/write | own event details plus matching card; no organization venue fallback |
| Manitoba Music | opt-in shadow/write | numeric identity, calendar dates/showtimes/cancellations; metadata enrichment |
| Winnipeg Rotary | opt-in shadow/write | public event pages; existing poster/QR checks and private-contact exclusion |

Use `WINNIGO_EXTRACTION_SOURCES=tourism-winnipeg=shadow` to compare or `=write` to import.
`WINNIGO_EXTRACTION_MAX_PAGES` defaults to 100 and can be set to 1–400. Page-limit skips are
recorded rather than silently omitted. Budget and elapsed-time limits still apply. Full-source
QA uses 400 pages and a longer explicit local test deadline; keep worker limits within its job
lease. Annual review-only pages never count as parser fallbacks or create duplicate imports.

Rollback: remove the source from `WINNIGO_EXTRACTION_SOURCES` to use its parser, or choose shadow
mode to compare without writing. This does not reverse existing records or owner edits. Parser
refreshes preserve verified precise times, while failed detail refreshes retain known metadata.
Do not change production scheduling or destination to exercise a local feature.

## Remaining source facts

[Issue #60](https://github.com/pricezhang42/winnigo/issues/60) tracks source-side gaps: two 404 photo
URLs, disputed show closing bounds, unverified visiting-day blocks, the changed Nourish redirect,
and a currently absent Cannes Lions price. The collector reports or holds these facts. It does
not invent replacements or change an event's identity to follow a redirect.

## Expanded HTML verification — November 17

Issue #63 adds The Forks, Assiniboine Park, Travel Manitoba, Winnipeg Rotary and Manitoba Music
to the same shadow/write pipeline. Manitoba Music is ported from its existing collector without
merging unrelated branch changes. Structured feeds remain direct parsers. No production
destination, audience, schedule or deployment changed.

The Forks' new unlinked headings/See More buttons now parse correctly. Its explicit current and
next month calendars preserve multiple date blocks for a repeated event URL. Calendar dates
override a detail page's broad range. Park supports both ordinary event pages and dedicated
pages such as Zoo Lights. A unique date-only fallback can gain a quoted time while keeping its
occurrence ID; competing same-day sessions still require review.

Rotary's home widget has disappeared. Discovery now falls back to the public ClubRunner calendar,
validates the requested months, filters dates and accepts only own club event-page links. Speaker
links are excluded. Public event pages retain the existing poster/registration verification and
private-contact exclusion. Fresh discovery found one in-window public event, Remembrance Day
Service, November 9, 18:00–22:00. Its old stable UID survives. This resolves #64.

A bounded **13-page live pilot** covers three pages each for Forks, Park, Travel Manitoba and
Music, plus Rotary's one current public event. Final results: **10 accepted enrichments, three
parser fallbacks, zero provider failures**. Repeating the same prepared snapshots used **13 cache
hits, no paid calls, zero changed records**. All **12 attached private photo objects** passed
integrity verification; every listing stays within the three-photo cap. This is targeted
coverage, not a full live AI collection of every event from these five sources.

The conservative fallbacks are explicit: Zoo Lights produced unsupported schedule quotes;
Wallflower's printed start dates disagree; one Music page with a generic event heading returned
no main event. Their native records remain. The prompt now distinguishes daily opening blocks
from continuous multi-day attendance, preserving closed-day gaps rather than creating overnight
visits. We do not import an unsupported schedule to improve an acceptance count.

The latest prompt also ran the original **50-event + 13-control** pilot in full, with no retries
substituted: **419/423 checks**, no missing event responses, no API/structural errors and
**0/13 control false positives**. Price and availability each matched **50/50**. Cost estimate:
**US$0.054100** using the configured rates. A scoring bug initially read only the first of two
correctly extracted Train of Terror date blocks. Aggregating all finite recurrence bounds and
rescoring those same outputs, without changing labels or calling the model again, gives
**420/423 total (99.3%) and 175/177 core (98.9%)**. Both reports are retained privately. The three
remaining scored misses are the disputed gallery start, Boo's missing published weekday rule
(despite explicit dates), and detail-only DOME's unknown end time.

The expanded PostgreSQL check exercises all five source IDs through writes, unique date/time
refinement, provider failure and owner/session override preservation. P2/P5 checks, **237 unit tests**,
typecheck/build, dev/built asset checks and seeded browser regression pass. Focused Chrome checks
verify future Forks/Park/Travel cards, dated times, loaded photos and no duplicate cards. Music
and Rotary pilot dates are already past, so they are correctly absent from discovery and verified
in the collection desk instead. No severe browser console errors were recorded. Browser evidence
and source/model reports remain local under `.winnigo/html-rollout-20261117`; raw candidates,
keys and private configuration are never committed.
