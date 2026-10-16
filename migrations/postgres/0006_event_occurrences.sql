-- Event details remain in listings; occurrences contain schedule facts and session exceptions.
ALTER TABLE occurrences ADD COLUMN occurrence_id text;
-- Old series rows were overall-run placeholders, not verified visiting intervals.
-- Their original bounds remain in listings.payload; explicit occurrence samples are converted by the shared data migration.
DELETE FROM occurrences WHERE details->>'schedule' = 'series';
UPDATE occurrences SET occurrence_id = listing_id, details = details || jsonb_build_object('id',listing_id,'status','active','timeZone','America/Winnipeg','url',(SELECT payload->>'url' FROM listings WHERE id=listing_id));
ALTER TABLE occurrences ALTER COLUMN occurrence_id SET NOT NULL;
ALTER TABLE occurrences DROP CONSTRAINT occurrences_pkey;
ALTER TABLE occurrences ADD PRIMARY KEY (listing_id, occurrence_id);
ALTER TABLE occurrences ADD COLUMN hidden boolean NOT NULL DEFAULT false;
ALTER TABLE occurrences ADD COLUMN override jsonb NOT NULL DEFAULT '{}';
CREATE INDEX occurrences_dates_idx ON occurrences ((details->>'start'), (details->>'end'), listing_id);
ALTER TABLE occurrences ADD CONSTRAINT occurrence_public_identity UNIQUE(occurrence_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE schedule_coverage (
 listing_id text NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
 first_day date NOT NULL, last_day date NOT NULL, complete boolean NOT NULL,
 checked_at timestamptz NOT NULL, source_url text, basis text NOT NULL DEFAULT 'calendar',
 PRIMARY KEY(listing_id,first_day,last_day), CHECK(last_day>=first_day)
);
CREATE TABLE event_aliases (
 legacy_id text PRIMARY KEY, listing_id text NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
 occurrence_id text, archived_record jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE occurrence_grants (
 user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
 listing_id text NOT NULL, occurrence_id text NOT NULL,
 PRIMARY KEY(user_id,listing_id,occurrence_id),
 FOREIGN KEY(listing_id,occurrence_id) REFERENCES occurrences(listing_id,occurrence_id) ON DELETE CASCADE
);
ALTER TABLE audit_records ADD COLUMN occurrence_id text;

CREATE TABLE event_alias_media (
 legacy_id text NOT NULL REFERENCES event_aliases(legacy_id) ON DELETE CASCADE,
 media_id text NOT NULL REFERENCES media(id), PRIMARY KEY(legacy_id,media_id)
);
