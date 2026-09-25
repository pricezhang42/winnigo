CREATE TABLE sources (id text PRIMARY KEY, report jsonb NOT NULL DEFAULT '{}');
CREATE TABLE listings (
 id text PRIMARY KEY, source text NOT NULL REFERENCES sources(id), payload jsonb NOT NULL,
 document jsonb NOT NULL, hidden boolean NOT NULL DEFAULT false,
 visibility text NOT NULL DEFAULT 'restricted' CHECK (visibility IN ('public','restricted')),
 dedupe_key text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listings_source_idx ON listings(source);
CREATE INDEX listings_document_idx ON listings USING gin(document);
CREATE INDEX listings_title_idx ON listings ((document->>'title'),id);
CREATE TABLE source_identities (source text NOT NULL REFERENCES sources(id), external_key text NOT NULL, listing_id text NOT NULL REFERENCES listings(id), PRIMARY KEY(source,external_key));
CREATE TABLE listing_overrides (listing_id text PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE, fields jsonb NOT NULL DEFAULT '{}');
CREATE TABLE occurrences (listing_id text NOT NULL REFERENCES listings(id) ON DELETE CASCADE, ordinal integer NOT NULL, details jsonb NOT NULL, PRIMARY KEY(listing_id,ordinal));
CREATE TABLE locations (listing_id text PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE, details jsonb NOT NULL);
CREATE TABLE trail_variants (listing_id text NOT NULL REFERENCES listings(id) ON DELETE CASCADE, ordinal integer NOT NULL, details jsonb NOT NULL, PRIMARY KEY(listing_id,ordinal));
CREATE TABLE media (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'), object_key text NOT NULL UNIQUE,
 content_type text NOT NULL, size bigint NOT NULL CHECK(size>=0), status text NOT NULL CHECK(status IN ('uploading','ready')),
 created_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz NOT NULL DEFAULT (now()+interval '24 hours')
);
CREATE TABLE listing_media (listing_id text NOT NULL REFERENCES listings(id) ON DELETE CASCADE, media_id text NOT NULL REFERENCES media(id), ordinal integer NOT NULL, PRIMARY KEY(listing_id,ordinal), UNIQUE(listing_id,media_id));
CREATE INDEX listing_media_media_idx ON listing_media(media_id);
CREATE TABLE comment_notes (listing_id text NOT NULL REFERENCES listings(id) ON DELETE CASCADE, ordinal integer NOT NULL, text text NOT NULL, source_url text NOT NULL, PRIMARY KEY(listing_id,ordinal));
CREATE TABLE collection_runs (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, source text NOT NULL REFERENCES sources(id), status text NOT NULL, counts jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE audit_records (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, action text NOT NULL, listing_id text REFERENCES listings(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE migration_runs (id text PRIMARY KEY, manifest_hash text NOT NULL, status text NOT NULL CHECK(status IN ('running','complete')), checkpoint jsonb NOT NULL DEFAULT '{}', report jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now());
