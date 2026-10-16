# Shared event schedules: local verification

Event descriptions, venue information and photos live in one listing. Linked `occurrences`
contain typed dates, timestamps, timezone, status and source links; recurring discovery cards project those
rows without duplicating the underlying event details. Exhibitions also project a separate card for every linked visiting day.
Owner changes to a single session remain session overrides. Legacy IDs resolve through archived
aliases, preserving their edits, grants, audit history and media references.

Date searches (Visit date, Today and This weekend) match active visiting intervals rather than
an exhibition's overall date range. Availability is `available`, `unavailable` or `unknown`.
A missing interval means unavailable only inside verified complete calendar/hour coverage;
elsewhere it means unknown. Overall run bounds still constrain availability. Hours rules support
verified dated weekly schedules, exceptional openings and closures, using America/Winnipeg DST.
No venue hours are guessed or applied globally to every source.

## Occurrence columns

`start_date` and `end_date` are required PostgreSQL `date` values. `start_at` and `end_at`
are nullable `timestamptz` values; date-only events keep both null. `time_zone` retains the
IANA timezone because PostgreSQL stores timestamp instants without their original timezone.
`time_label` retains the display text, and `status`, `source_url` and `basis` are columns too.
The `details` JSON holds original published timestamp text and optional source metadata.
Owner overrides remain in their separate JSON column.

Migration `0007_typed_occurrence_schedule.sql` backfills existing rows, removes duplicate
schedule keys from JSON, adds date/timestamp/status constraints and replaces the JSON-expression
date index with an index on active, visible occurrence date columns. Repository reads reconstruct
the existing API shape; timestamps use ISO UTC while preserving source text in `publishedStart`
and `publishedEnd`. API and UI consumers need no field-name changes.

```sql
SELECT l.document->>'title' AS title,
       o.start_date, o.end_date, o.start_at, o.end_at,
       o.time_zone, o.time_label, o.status
FROM occurrences o
JOIN listing_records l ON l.id = o.listing_id
WHERE l.document->>'title' ILIKE '%DOME%'
ORDER BY o.start_date, o.start_at;
```

## Migration

Back up the selected local database first. The schema migration and data conversion are separate:

```sh
node --env-file=.winnigo/events-qa.env scripts/migrate-postgres.mjs
node --env-file=.winnigo/events-qa.env scripts/migrate-event-schedules.mjs
node --env-file=.winnigo/events-qa.env scripts/migrate-event-schedules.mjs --apply
```

Without `--apply`, conversion only previews counts. Conversion makes no live source requests;
it preserves historical dates and owner changes. Re-running it must retain the same event and
occurrence counts. Seeding skips archived IDs so it cannot recreate converted duplicate records.

## Verification, October 16, 2026

Checks used isolated temporary PostgreSQL schemas/S3 prefixes and a separate local
`winnigo_events_qa` database cloned from `winnigo_p2_qa`. The original QA database and production
were not migrated. Schedules stayed disabled.

- Storage/migration (`check:p2`), accounts/access (`check:p3`) and collection jobs (`check:p5`) pass.
- Added database checks cover exceptional openings, closed Mondays, holiday closure, DST,
  unknown dates outside coverage and superseding dates after hours rules are removed.
- Added permission checks confirm a grant to one restricted session exposes neither sibling
  dates nor complete calendar coverage.
- Conversion changed 871 source records into 650 shared events and 345 linked occurrences;
  a second conversion retained the same counts. All 222 archived IDs resolved and their stored
  owner edits were preserved. Occurrence rows contained no descriptions, titles or image lists.
- 104 unit tests, TypeScript checking and production build pass.
- Asset checks validate both CSS and JavaScript on built port 5182 and dev port 5184.
- The full browser regression passes on both servers, including pagination, maps, trail details,
  photos and persisted synthetic admin edits. The dev origin mismatch found during verification
  was corrected in its launch configuration.
- Selenium checks verify the selected-date filter, exceptional opening hours, closed-day exclusion,
  unknown future dates, one shared DOME@HOME event with distinct date cards, loaded photos and
  zero browser console errors on both servers.

Visiting-hours closure tests use the explicitly synthetic **QA Visiting Calendar** fixture.
They do not establish Manitoba Museum's real opening hours. Converted old snapshots retain
only their observed dates; a subsequent complete source collection can establish full calendar
coverage. The browser check requires this QA fixture and the DOME@HOME snapshot.

```sh
.winnigo/wag-venv/bin/python scripts/check-event-browser.py \
  --origins http://127.0.0.1:5182 http://127.0.0.1:5184
```

The ordinary `scripts/check-browser.py` additionally checks pagination, saved filters, photos,
interactive maps, trail details and synthetic admin edits. Launch dev with matching
`WINNIGO_ORIGIN=http://127.0.0.1:5184 PORT=5184`; the QA environment defaults to port 5182.
Browser screenshots and logs are private local evidence under `.winnigo/event-evidence`.

Typed-column migration verification (October 16): all 398 existing QA occurrence rows retained
their IDs, dates, timestamp instants, time labels, timezone, source URLs, statuses, hidden flags
and owner overrides. All 73 date-only rows retained null timestamps. Schedule fields no longer
appear in occurrence JSON. Database integration checks also exercise invalid date ranges,
timestamp pairs/order and statuses.

Exhibition presentation update (October 16): the continuous-exhibition display mode has been
removed. Migration `0008_exhibition_visiting_cards.sql` converts existing exhibition parents to
recurring events without duplicating their details or changing occurrence IDs. Overall run dates
remain source metadata. Only linked visiting dates produce dated discovery cards; missing dates
are not expanded from the overall run. Ordinary place cards remain places.

Shared listing columns and computed source/effective views are documented in [Typed listings](19-typed-listings.md).
