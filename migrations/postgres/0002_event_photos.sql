-- Private copies of collected event images (docs/18). `media_source_url` is the image URL the
-- copy was made from, so a changed image is copied again and a failed one is retried.
ALTER TABLE events
  ADD COLUMN media_id text REFERENCES media(id),
  ADD COLUMN media_source_url text;
CREATE INDEX events_media_idx ON events (media_id) WHERE media_id IS NOT NULL;
