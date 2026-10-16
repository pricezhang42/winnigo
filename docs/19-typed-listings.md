# Typed shared listing fields

Stable source fields now live once in PostgreSQL columns on `listings`:

- `title`, `description`, `listing_type`, `category`, `venue`, `address`, `neighbourhood`
- `source_url`, nullable `price`, `family`, `indoor`, `status`
- `start_date`, `end_date`, `closing_month`, `schedule_kind`, `recurring`

`metadata` contains source-specific fields such as original wording, trail details, images,
uncertainty and verified visiting schedules. It cannot contain duplicate shared-field keys.
`source_fields` records which optional source fields were present, so an explicit null remains
an explicit null and an absent value stays absent in the API. A closing month stays a month;
its migration never supplies an exact closing day. Unknown prices remain null.

Owner corrections remain in `listing_overrides`; hidden flags, visibility and stable IDs remain
on `listings`. Schedule rows, permissions, private media associations and audit records are unchanged.

## Computed read views

The physical `payload` and `document` columns are removed by migration
`0009_typed_listing_fields.sql`. Two ordinary, non-materialized views retain the API contracts:

- `listing_source_records.payload` reconstructs normalized source JSON from typed fields and metadata.
- `listing_records.document` applies owner corrections and hidden state, derives collection labels,
  and attaches the existing resolved map location. Its `effective_*` columns expose corrected values
  for SQL filtering and sorting.

These views do not store second copies. Changes to an existing owner override immediately affect
view reads. Maps continue to use the existing `locations` relation and JavaScript resolution on
normal repository writes; the migration does not invent or change geometry. The repository still
maintains deduplication keys and related child records transactionally.

```sql
-- Source values, useful for inspecting collected data.
SELECT id, title, venue, price, start_date, end_date, closing_month
FROM listings
WHERE title ILIKE '%Paper Trail%';

-- Effective values after owner corrections.
SELECT id, effective_title, effective_price, effective_status
FROM listing_records
WHERE effective_title ILIKE '%Paper Trail%';

-- Original source-specific data and the reconstructed API representations.
SELECT metadata FROM listings WHERE id = 'your-event-id';
SELECT payload, document FROM listing_records WHERE id = 'your-event-id';
```

Common title, venue, category, neighbourhood, type, admission, family/indoor and date predicates
use the projected typed values. Source-specific filters such as trail difficulty remain JSON-based.
The API field names and the fixture repository's JSON contract stay compatible.

## Migration and local evidence

Back up the selected database and stop app/worker processes using the old code before upgrading.
Run the normal migration command with the intended local environment:

```sh
node --env-file=.winnigo/events-qa.env scripts/migrate-postgres.mjs
```

Use the matching updated app code after migration. This is a schema change; old binaries that query
physical payload/document columns are incompatible. A rollback requires restoring the pre-migration
backup together with its previous code. Production has not been migrated.

October 16, 2026 verification:

- A before/after comparison of all 652 listings in the separate `winnigo_events_qa` database found
  exactly equal reconstructed source/effective JSON, hidden state, visibility and deduplication keys.
- Occurrences, owner overrides, grants, media, audit records, aliases and source identities were unchanged.
- P2 tests backfill full and minimal legacy records, preserve absent/null fields and closing-month
  precision, verify explicit-null price overrides and immediate owner-title/free-price filtering,
  and reject negative prices, invalid months and reversed date bounds.
- P2/P3/P5 integration suites pass; repeated collection remains idempotent and owner/session edits survive.
- 104 unit tests, TypeScript checking and the production build pass.
- Real CSS/JavaScript asset checks, full Chrome regressions (including maps and synthetic admin
  edits) and focused recurring/exhibition/date-availability checks pass on both built and dev servers.

Browser checks use the separately migrated QA database, synthetic QA fixtures and loopback built
port 5182/dev port 5184. Schedules remain disabled. The original QA database and production are unchanged.

Tracks GitHub issue #25; follows the shared occurrence work in #23 / PR #24.
