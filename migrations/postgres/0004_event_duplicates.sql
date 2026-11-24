-- Cross-source duplicate events (#66, lib/server/event-duplicates.mjs). A verified duplicate
-- points at the event shown in its place; non-admin readers see only the canonical event, which
-- lists the duplicate's source as "also listed by". Recomputed after every collection run.
ALTER TABLE events ADD COLUMN duplicate_of text REFERENCES events(id) ON DELETE SET NULL;
CREATE INDEX events_duplicate_of_idx ON events (duplicate_of) WHERE duplicate_of IS NOT NULL;
