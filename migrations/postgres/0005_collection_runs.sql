-- P5: one row per collection job, from queueing (manual refresh) or first attempt to the result.
-- Earlier rows (collector batches) keep their source/status/counts and leave the new columns null.
ALTER TABLE collection_runs
  ADD COLUMN job_id text UNIQUE,
  ADD COLUMN trigger text CHECK (trigger IN ('schedule', 'manual', 'catch-up', 'collector')),
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN finished_at timestamptz,
  ADD COLUMN error text;
CREATE INDEX collection_runs_source_created_idx ON collection_runs (source, created_at DESC);
