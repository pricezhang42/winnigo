-- P1 only establishes migration ownership. Domain tables arrive in P2.
CREATE TABLE IF NOT EXISTS winnigo_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
