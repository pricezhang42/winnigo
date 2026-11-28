ALTER TABLE events ADD COLUMN event_kind text NOT NULL DEFAULT 'event'
  CHECK (event_kind IN ('event', 'class'));

-- Older imports filled a missing end with the start. Store unknown ends as NULL.
UPDATE event_sessions SET end_at = NULL WHERE end_at = start_at;
ALTER TABLE event_sessions DROP CONSTRAINT event_sessions_check1;
