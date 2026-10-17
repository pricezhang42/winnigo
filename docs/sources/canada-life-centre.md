# Canada Life Centre

Manual-only public ICS collector for Canada Life Centre's concerts, sports and touring shows.
It uses ordinary HTTP and the venue's Calendarize It feed. No Selenium, FlareSolverr, event-page
crawl or production schedule is needed.

- Calendar: <https://www.canadalifecentre.ca/calendar/>
- Feed: <https://www.canadalifecentre.ca/?rhc_action=get_icalendar_events&post_type%5B%5D=events&taxonomy=calendar&terms=events%2Cjets_events%2Cmoose_events%2Csea_bears&ics=1>
- Source ID: `canada-life-centre`
- Implementation: `lib/server/ics.mjs`, `lib/server/canada-life-centre.mjs`

## Collection and data model

The default horizon is the full current and next **America/Winnipeg calendar months** using the
common `collectionWindow` helper. October 2026 collection includes October 1–November 30, even
though discovery hides cards whose published end date is past. The feed's historical/future
records are filtered rather than imported wholesale.

An explicit source UID identifies the shared listing; a hashed UID/recurrence key identifies each
linked performance. Different UIDs do not merge just because their titles, URLs and dates match.
Recurring performances use separate date cards and the common typed listing/occurrence tables.
No separate exhibition display rules are introduced.

The pinned `node-ical` parser expands bounded RRULEs; the adapter adds RDATE (including PERIOD)
and floating-time handling, plus explicit exclusions/cancellations and moved RECURRENCE-ID
instances. UTC instants, TZID values and DST are respected; floating times use X-WR-TIMEZONE or
Winnipeg. All-day DATE intervals retain date-only precision and convert exclusive DTEND to an
inclusive last day without creating midnight timestamps.

Small source changes specific to one performance, such as an overridden title, live in lightweight
`sourceOverrides`. Shared owner corrections take precedence, followed by any session-level owner
corrections. Missing end times are not displayed as confirmed end times. Unknown admission remains
null. Attendees, organizers' contact identities and raw calendar text are not persisted.

A complete, explicitly identified event can supersede its own old in-window dates after a source
reschedule; the rows and their owner edits remain in history. EXDATE and explicit cancellations
are stored as cancelled occurrences. Missing events from the overall feed are retained, never
inferred cancelled. Partial or failed reads do not supersede missing dates or erase previous data.

Unsupported EXRULE/custom timezone/THISANDFUTURE ranges and excessive recurrence density fail
safely or withhold the affected UID group. Bounded historical defects are skipped only when all
relevant dates are demonstrably outside the horizon. Malformed in-window groups make collection
partial; a truncated or non-calendar response fails without imports. Response/event/occurrence
limits bound processing.

The ICS feed has no event photos. The collector enriches it from the venue's bounded public
calendar JSON, matching canonical event URL and start instant. It prefers `image_full` over
thumbnail variants and stores at most three distinct event images per shared listing through the
common private-media pipeline. Downloads accept only the venue's upload origins, reject redirects,
limit bytes and verify JPEG/PNG/WebP signatures. Repeated images reuse stored private references.
Dry runs verify source image metadata without downloading or writing photos.

Calendar or image failures make collection partial while preserving previously stored photos and
refreshed event dates. Admission remains unknown and descriptions retain source summary text;
no event-detail pages are crawled. Events without published images retain the labeled placeholder.

## Commands

```sh
# Read-only live dry run: logs counts and the exact month window, not full candidates.
npm run collect:clc

# Compare canonical URL/start and end instants with the venue's independent calendar response.
npm run collect:clc -- --compare

# Explicitly queue a manual collection into the selected database.
node --env-file=.winnigo/events-qa.env scripts/collect-clc.mjs --enqueue

# Worker handles manual Refresh requests; schedules remain disabled.
WINNIGO_SCHEDULES=disabled node --env-file=.winnigo/events-qa.env scripts/worker.mjs
```

The CLI and worker honor the explicitly selected environment. The QA environment is ignored by
Git; never copy its secrets into commands, documentation or issues. This source is `manualOnly`
and has no entry in the scheduler. Nothing redirects production collection.

## October 16, 2026 evidence

The live feed contained 1,424 VEVENT components. The bounded October 1–November 30 read produced
**38 performances**. All 38 matched the venue's public calendar response by canonical event URL,
start instant and end instant; there were zero feed-only/calendar-only entries or end differences.
These are dated observations, not hardcoded live test expectations.

A manual pg-boss job saved 38 shared event records and 38 typed occurrence rows into the separate
`winnigo_events_qa` database. A verified snapshot replay twice reported all 38 unchanged, with no
new records or cancellations. Past October performances remain stored but are hidden from normal
upcoming discovery. The original QA database and production are unchanged.

Photo enrichment updated all 38 QA events with one event-specific image each (24 distinct stored
images shared where appropriate). Authenticated photo reads return image bytes; anonymous reads
return 401. Chrome checks confirm loaded card images on both built and development QA apps.

Synthetic fixtures cover verified image selection, private-reference reuse, download caching,
three-photo limits, foreign media rejection and previous-photo retention on enrichment failures.
They also cover same-day/same-URL performances, DST, UTC and floating times, all-day
exclusive ends, RRULE/RDATE/PERIOD, exact exclusions, moved/cancelled overrides, bounded historical
malformations, truncated responses and unsafe links. P5 checks cover queue integration, repeat
imports, parent/session owner edits, rescheduling history, partial/failed reads and disabled schedules.

Terms/access follow-up remains skipped at the owner's explicit request; no terms review was performed.
Tracks #19, under #18 and #1.
