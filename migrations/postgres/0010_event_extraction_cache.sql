CREATE TABLE event_extraction_cache (
  cache_key text PRIMARY KEY,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE event_extraction_usage (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cache_key text NOT NULL,
  source text NOT NULL,
  model text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('hit', 'ok', 'error')),
  error_code text,
  metrics jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'error') = (error_code IS NOT NULL))
);

CREATE INDEX event_extraction_usage_source_date_idx ON event_extraction_usage (source, created_at);
