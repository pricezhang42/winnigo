-- Schedule facts are typed and indexed. JSON retains original source text and optional metadata.
ALTER TABLE occurrences
  ADD COLUMN start_date date,
  ADD COLUMN end_date date,
  ADD COLUMN start_at timestamptz,
  ADD COLUMN end_at timestamptz,
  ADD COLUMN time_label text NOT NULL DEFAULT '',
  ADD COLUMN time_zone text NOT NULL DEFAULT 'America/Winnipeg',
  ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD COLUMN source_url text,
  ADD COLUMN basis text NOT NULL DEFAULT 'event';

UPDATE occurrences o SET
  start_date = (details->>'start')::date,
  end_date = coalesce(details->>'end', details->>'start')::date,
  start_at = (details->>'startAt')::timestamptz,
  end_at = coalesce(details->>'endAt', details->>'startAt')::timestamptz,
  time_label = coalesce(details->>'time', ''),
  time_zone = coalesce(details->>'timeZone', 'America/Winnipeg'),
  status = coalesce(details->>'status', 'active'),
  source_url = coalesce(details->>'url', (SELECT payload->>'url' FROM listings WHERE id=o.listing_id)),
  basis = coalesce(details->>'basis', 'event'),
  details = (details || jsonb_strip_nulls(jsonb_build_object(
    'publishedStart', coalesce(details->>'publishedStart', details->>'startAt'),
    'publishedEnd', coalesce(details->>'publishedEnd', details->>'endAt')
  ))) - ARRAY['id','start','end','startAt','endAt','time','timeZone','status','url','basis'];

ALTER TABLE occurrences
  ALTER COLUMN start_date SET NOT NULL,
  ALTER COLUMN end_date SET NOT NULL,
  ALTER COLUMN source_url SET NOT NULL,
  ALTER COLUMN details SET DEFAULT '{}',
  ADD CONSTRAINT occurrence_date_order CHECK (end_date >= start_date),
  ADD CONSTRAINT occurrence_timestamp_pair CHECK ((start_at IS NULL) = (end_at IS NULL)),
  ADD CONSTRAINT occurrence_timestamp_order CHECK (end_at >= start_at),
  ADD CONSTRAINT occurrence_status CHECK (status IN ('active','cancelled','superseded'));

DROP INDEX occurrences_dates_idx;
CREATE INDEX occurrences_dates_idx ON occurrences (start_date, end_date, listing_id)
  WHERE status='active' AND NOT hidden;
