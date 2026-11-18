-- Shadow-mode extraction results compared with the parser listing for the same event page.
-- Rows describe public source pages only; they never change listings.
CREATE TABLE event_extraction_comparisons (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint REFERENCES collection_runs(id) ON DELETE CASCADE,
  source text NOT NULL,
  page_url text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('agree', 'differ', 'withheld', 'failed', 'skipped')),
  reason text,
  cache_hit boolean NOT NULL DEFAULT false,
  estimated_cost_usd numeric,
  differences jsonb NOT NULL DEFAULT '[]',
  extracted jsonb,
  -- The validated model output, kept for differ and withheld rows so a person can see why.
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX event_extraction_comparisons_source_date_idx
  ON event_extraction_comparisons (source, created_at DESC);
