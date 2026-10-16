-- Stable source fields live once in typed columns. JSON stores source-specific metadata.
ALTER TABLE listings
  ADD COLUMN title text,
  ADD COLUMN description text,
  ADD COLUMN listing_type text,
  ADD COLUMN category text,
  ADD COLUMN venue text,
  ADD COLUMN address text,
  ADD COLUMN neighbourhood text,
  ADD COLUMN source_url text,
  ADD COLUMN price numeric,
  ADD COLUMN family boolean,
  ADD COLUMN indoor boolean,
  ADD COLUMN status text,
  ADD COLUMN start_date date,
  ADD COLUMN end_date date,
  ADD COLUMN closing_month text,
  ADD COLUMN schedule_kind text,
  ADD COLUMN recurring boolean,
  ADD COLUMN source_fields text[] NOT NULL DEFAULT '{}',
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';

UPDATE listings SET
  title=payload->>'title', description=payload->>'description', listing_type=payload->>'type',
  category=payload->>'category', venue=payload->>'venue', address=payload->>'address',
  neighbourhood=payload->>'neighbourhood', source_url=payload->>'url',
  price=(payload->>'price')::numeric, family=(payload->>'family')::boolean,
  indoor=(payload->>'indoor')::boolean, status=payload->>'status',
  start_date=(payload->>'start')::date, end_date=(payload->>'end')::date,
  closing_month=payload->>'endMonth', schedule_kind=payload->>'schedule',
  recurring=(payload->>'recurring')::boolean,
  source_fields=ARRAY(SELECT key FROM jsonb_object_keys(payload) AS keys(key) WHERE key=ANY(ARRAY[
    'title','description','type','category','venue','address','neighbourhood','url','price',
    'family','indoor','status','start','end','endMonth','schedule','recurring'])),
  metadata=payload-ARRAY['id','source','title','description','type','category','venue','address',
    'neighbourhood','url','price','family','indoor','status','start','end','endMonth','schedule','recurring'];

ALTER TABLE listings
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN source_url SET NOT NULL,
  ADD CONSTRAINT listing_title_required CHECK (length(trim(title))>0),
  ADD CONSTRAINT listing_price_valid CHECK (price>=0 AND price<'Infinity'::numeric),
  ADD CONSTRAINT listing_dates_order CHECK (end_date>=start_date),
  ADD CONSTRAINT listing_month_valid CHECK (closing_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  ADD CONSTRAINT listing_metadata_object CHECK (jsonb_typeof(metadata)='object'),
  ADD CONSTRAINT listing_metadata_separate CHECK (NOT metadata ?| ARRAY['id','source',
    'title','description','type','category','venue','address','neighbourhood','url','price',
    'family','indoor','status','start','end','endMonth','schedule','recurring']),
  ADD CONSTRAINT listing_source_fields_valid CHECK (
    source_fields @> ARRAY['title','url'] AND source_fields <@ ARRAY[
    'title','description','type','category','venue','address','neighbourhood','url','price',
    'family','indoor','status','start','end','endMonth','schedule','recurring']);

-- Removing these columns also removes their old JSON document indexes.
ALTER TABLE listings DROP COLUMN payload, DROP COLUMN document;
CREATE INDEX listings_title_idx ON listings(title,id);
CREATE INDEX listings_run_dates_idx ON listings(end_date,closing_month);

-- Presence tracking preserves a source's explicit nulls versus absent optional keys.
CREATE VIEW listing_source_records AS
SELECT l.*, l.metadata || jsonb_build_object('id',l.id,'source',l.source) || coalesce((
  SELECT jsonb_object_agg(p.key,p.value) FROM jsonb_each(jsonb_build_object(
    'title',l.title,'description',l.description,'type',l.listing_type,'category',l.category,
    'venue',l.venue,'address',l.address,'neighbourhood',l.neighbourhood,'url',l.source_url,
    'price',l.price,'family',l.family,'indoor',l.indoor,'status',l.status,
    'start',l.start_date,'end',l.end_date,'endMonth',l.closing_month,
    'schedule',l.schedule_kind,'recurring',l.recurring
  )) p WHERE p.key=ANY(l.source_fields)
),'{}'::jsonb) AS payload
FROM listings l;

-- The effective document is computed on reads, never stored as a second full copy.
-- Map resolution remains in the existing locations relation; collection labels are derived.
CREATE VIEW listing_records AS
SELECT r.*,
  r.document->>'title' AS effective_title,
  r.document->>'venue' AS effective_venue,
  r.document->>'category' AS effective_category,
  r.document->>'neighbourhood' AS effective_neighbourhood,
  r.document->>'type' AS effective_type,
  (r.document->>'recurring')::boolean AS effective_recurring,
  (r.document->>'price')::numeric AS effective_price,
  (r.document->>'family')::boolean AS effective_family,
  (r.document->>'indoor')::boolean AS effective_indoor,
  r.document->>'status' AS effective_status,
  (r.document->>'start')::date AS effective_start_date,
  (r.document->>'end')::date AS effective_end_date,
  r.document->>'endMonth' AS effective_closing_month
FROM (
  SELECT s.*, ((s.payload || coalesce(o.fields,'{}'))-'status') ||
    CASE WHEN s.hidden THEN '{"status":"hidden"}'::jsonb
      WHEN 'status'=ANY(s.source_fields) THEN jsonb_build_object('status',s.status)
      ELSE '{}'::jsonb END ||
    jsonb_build_object('id',s.id,'collection',CASE s.source WHEN 'facebook' THEN 'Community Highlights'
      WHEN 'trails-manitoba' THEN 'Official Trails' ELSE '' END) ||
    CASE WHEN loc.details IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('mapLocation',loc.details) END
    AS document
  FROM listing_source_records s
  LEFT JOIN listing_overrides o ON o.listing_id=s.id
  LEFT JOIN locations loc ON loc.listing_id=s.id
) r;
