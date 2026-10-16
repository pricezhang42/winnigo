-- Exhibitions follow the same recurring date-card projection as other events.
-- Keep shared descriptions, overall run bounds, occurrence IDs and owner edits intact.
UPDATE listings SET
  payload = (payload - 'occurrenceMode') || '{"recurring":true,"schedule":"series","type":"Event"}'::jsonb,
  document = (document - 'occurrenceMode') || '{"recurring":true,"schedule":"series","type":"Event"}'::jsonb
WHERE coalesce(document->>'type','') <> 'Place'
  AND (payload->>'occurrenceMode'='continuous' OR payload ? 'runDates');

UPDATE listings SET payload=payload-'occurrenceMode',document=document-'occurrenceMode'
WHERE payload ? 'occurrenceMode' OR document ? 'occurrenceMode';
UPDATE listing_overrides SET fields=fields-'occurrenceMode' WHERE fields ? 'occurrenceMode';
