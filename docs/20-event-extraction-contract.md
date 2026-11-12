# Event extraction contract

Context version 1, model output version 3. Version 2 (issue #44) removes fields the app knows
or derives and replaces per-field evidence paths with one quote per fact. Version 3 makes each
model review reason name the fact it affects.

Issue #34, step 1 of Epic #33. This is an intermediate public-event format, independent of
the LLM provider and the database. Fetching, model calls and repository integration come later.

## One definition

`lib/contracts/event-extraction.mjs` defines strict Zod schemas using the installed `zod/v4`
subpath. `eventExtractionJsonSchema` and `extractionContextJsonSchema` export JSON Schema
Draft 7 directly from those definitions. `lib/contracts/event-extraction.ts` derives the
TypeScript types with `z.infer`; no second handwritten type or generated file needs updating.

Use `parseExtractionContext`, `parseEventExtraction` and `resolveExtractionDate` at runtime.
The raw Zod/JSON schemas describe structure; the parse functions also check relationships,
real calendar dates, context, URL provenance and evidence. Provider adapters may need to adapt
unsupported JSON Schema keywords, while keeping the complete runtime checks.

Print the provider-neutral JSON Schema or the complete synthetic examples:

```sh
node --input-type=module -e "import {eventExtractionJsonSchema as s} from './lib/contracts/event-extraction.mjs'; console.log(JSON.stringify(s,null,2))"
node --input-type=module -e "import {examples} from './scripts/fixtures/event-extraction.mjs'; console.log(JSON.stringify(examples,null,2))"
```

## Input context

Application code supplies `schemaVersion`, `source`, `pageUrl`, `checkedAt`, the Winnipeg
`timeZone`, the exact current/next-month `window`, and prepared `documents`.
Each document has a URL, text and `urls`: the relevant event, organizer, ticket and image URLs
identified by the page preparer. The page document is required; document URLs must be unique.
The window is checked against the reference timestamp in Winnipeg, including December rollover.
No ambient clock or model guess supplies today's date.

Document preparation must preserve source wording, headings, date/hour exceptions and relevant
URLs before summaries discard them. It must keep exhibition run bounds separate from a
calendar filter's bounds. It must not include secrets or private social data. Page text remains
untrusted data, including any instructions embedded in it.

See [page preparation](21-event-page-preparation.md) for the HTML-to-context implementation.

## Output and uncertainty

The model returns `{event: {...} | null}`: one main event, or null when the page has none.
All object fields are required and unknown keys are rejected. Unknown facts use `null`; an
empty array reports no facts of that kind. Neither implies complete collection or verified
closure. A null event is a valid result, not permission to delete previous listings.

The event has `title` and `titleQuote`; `venue {name, address, online, quote}`; `price {amount,
text, quote}`; `ticketUrl`, `organizerUrl`, up to three `imageUrls`; `schedule`; and
`reviewReasons`, each `{field, reason}` where field is title, schedule, venue, price, links or
other. Missing price is null, never free.

The model does **not** return: the source URL, timezone, schedule kind, end-day offsets,
currency, description, category, event status, image kind or caption, or evidence field paths.
`parseEventExtraction(value, context)` derives them and returns an internal event:

- `sourceUrl` is the context page URL; `timeZone` stays null (the app applies Winnipeg).
- `kind` is exhibition (run plus hours/exceptions), recurring, multiple or single.
- `endDayOffset` is 1 when the end time is not after the start time, the day difference when an
  end date is given, otherwise 0 for a known end time and null for an unknown one.
- A date's `cancelled` flag becomes its status; the event is cancelled only when every date is.
- `currency` is CAD when an amount is present. The description comes from the prepared page
  text; category is left to existing source/owner rules.
- Evidence entries are built from the quotes, attributed to the document that contains them.

Quotes are matched after NFKC and whitespace normalization against any supplied document.

- **Core facts** (title, run, each date, rule, hours period and exception): an unsupported or
  invalid entry is dropped and recorded as a review reason, so the event is held for review.
- **Optional facts** (venue, address, price): an unsupported value becomes null and is recorded
  as an `issue`; the event is not held. Link and image URLs absent from the documents are dropped.
- **Model-reported conflicts** hold the event when they name title, schedule or other. Venue,
  price and link conflicts are recorded as issues; the model leaves those values unknown.

The parser throws only for structural problems (wrong types, unknown keys, size limits).
This checks provenance, **not that the model interpreted the quote correctly**. Validation is
not a publication decision or a confidence score.

## Schedule facts

- `kind`: single, multiple, recurring, exhibition, or unknown.
- `dates`: explicit performances, including different times on the same day and cancellation facts.
- `recurrence`: daily, weekly, or monthly rules; interval, optional bounds and published times.
  Monthly rules select month days or ordinal weekdays (`weekOfMonth: 1` for first Friday,
  `-1` for last Friday). Weekdays use Sunday=0 through Saturday=6.
- `run`: the complete published event/exhibition bounds, independent of the collection window.
- `hours`: dated weekly visiting schedules, including their verified applicable period.
  A missing weekday in a complete verified schedule is closed; incompletely extracted hours
  cannot establish that a venue is closed. Collection/review code must establish completeness.
- `exceptions`: dated closures or exceptional openings. `through: null` means the same day
  for an exception. `closed: true` requires null intervals; an exceptional opening with null
  intervals means its hours are unknown.

Dates are `{year, month, day}`. `day: null` preserves month precision, such as April 2027.
`year: null` preserves a missing year. `resolveExtractionDate` applies the reference timestamp's
Winnipeg year and returns `{value, precision, yearAssumed}` without changing the input. An invalid
assumed date is rejected rather than rolled into another day/year. No year rollover is guessed:
an unqualified December–January range needs review if the current-year default reverses it.

Times are local `HH:mm` values. Unknown start/end times stay null; the app derives day offsets
(see above). An end date before its start date is held for review. A rule's `from`/`through` delimit the
recurrence, not an individual performance's duration. Shared
code expands verified rules and converts local times through DST; the contract never invents
UTC offsets or treats an unknown time as midnight. Ambiguous DST wall times need review later.

## Mapping to existing data (step 4)

| Extraction facts | Existing boundary |
| --- | --- |
| Source URL, title, description, category, venue/address, status | Source listing fields; existing code generates identity, checks categories and preserves owner overrides |
| Price amount/currency/wording | Nullable `price` plus `admission`; unsupported currencies/policies need review, not automatic numeric conversion |
| Organizer/ticket URLs | Source metadata and `ticketUrl`; retain the collected event URL as the original source link |
| Full run dates | `runDates.start/end/endMonth`; a month-only start remains uncertainty metadata until supported, never a fabricated first day |
| Explicit dates and recurrence | Shared `occurrences`, `recurring`, timestamps, `endTimeKnown`, and session status after deterministic normalization/filtering |
| Visiting hours and exceptions | Verified `visitingSchedule.periods/weekly/exceptions` and daily cards through shared schedule logic |
| Missing-year resolution | `yearAssumed` plus original date components/evidence; review impossible or reversed assumed dates |
| Up to three image URLs | Published source URLs → private media pipeline → `sourceImages` and `images`; an existing stored cover is kept |
| Quotes and review reasons | Bounded source metadata/review records; unknown required facts withhold publication |

Schedule completeness, source identities, deduplication, grants, hidden state, owner overrides,
photo storage IDs and SQL are not model fields. Only collector/application code may set them.
Recurring programs and exhibitions retain one parent with linked dates. Run bounds alone cannot
prove a visiting day is open. Unbounded or incomplete hours require verified collection bounds
and review before mapping to the existing materializer; no implicit 24-hour opening is allowed.

## Limits and verification

UTF-8 JSON caps are 128 KiB context and 256 KiB result. Maximums: 10 documents, 40,000 characters
and 200 URLs per document, 200 explicit dates, 24 recurrence/hour periods, 100 exceptions,
3 images and 20 review reasons. Quotes cap at 600 characters. Limits reject the result instead
of silently clipping it.

`scripts/fixtures/event-extraction.mjs` contains eight synthetic examples: a single event,
multiple showtimes/dates, a DST-crossing weekly program, first Fridays, an exhibition with
Monday/holiday closures and month-precision closing date, missing year/time, conflicting dates,
and photo/ticket links. Unit tests exercise validation and the existing visiting-hour/DST
boundaries; compile-time checks confirm the inferred types retain nullable facts and reject
repository fields. These examples verify the contract, not real-source accuracy or model quality.
