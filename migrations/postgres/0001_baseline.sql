-- Winnigo schema baseline (docs/30, 2026-11-23). Replaces migrations 0001–0012: listings hold
-- trails, places and community highlights; events collected from the source list live in
-- `events` and `event_sessions`. A database created by the earlier migrations is reset once
-- with `npm run db:reset` (local only; the Node database has no production data).

-- Sources and their latest collection report.
CREATE TABLE sources (id text PRIMARY KEY, report jsonb NOT NULL DEFAULT '{}');

-- Listings: stable source fields in typed columns, source-specific metadata as JSON.
CREATE TABLE listings (
  id text PRIMARY KEY,
  source text NOT NULL REFERENCES sources(id),
  hidden boolean NOT NULL DEFAULT false,
  visibility text NOT NULL DEFAULT 'restricted' CHECK (visibility IN ('public', 'restricted')),
  dedupe_key text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  title text NOT NULL CONSTRAINT listing_title_required CHECK (length(trim(title)) > 0),
  description text,
  listing_type text,
  category text,
  venue text,
  address text,
  neighbourhood text,
  source_url text NOT NULL,
  price numeric CONSTRAINT listing_price_valid CHECK (price >= 0 AND price < 'Infinity'::numeric),
  family boolean,
  indoor boolean,
  status text,
  start_date date,
  end_date date,
  schedule_kind text,
  -- Which typed fields the source supplied, so explicit nulls survive a round trip.
  source_fields text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  CONSTRAINT listing_dates_order CHECK (end_date >= start_date),
  CONSTRAINT listing_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT listing_metadata_separate CHECK (NOT metadata ?| ARRAY['id', 'source', 'title',
    'description', 'type', 'category', 'venue', 'address', 'neighbourhood', 'url', 'price',
    'family', 'indoor', 'status', 'start', 'end', 'schedule']),
  CONSTRAINT listing_source_fields_valid CHECK (source_fields @> ARRAY['title', 'url']
    AND source_fields <@ ARRAY['title', 'description', 'type', 'category', 'venue', 'address',
    'neighbourhood', 'url', 'price', 'family', 'indoor', 'status', 'start', 'end', 'schedule'])
);
CREATE INDEX listings_source_idx ON listings (source);
CREATE INDEX listings_title_idx ON listings (title, id);
CREATE INDEX listings_end_date_idx ON listings (end_date);

CREATE TABLE listing_overrides (
  listing_id text PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  fields jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE locations (
  listing_id text PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  details jsonb NOT NULL
);
CREATE TABLE trail_variants (
  listing_id text NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  details jsonb NOT NULL,
  PRIMARY KEY (listing_id, ordinal)
);
CREATE TABLE media (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  object_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  size bigint NOT NULL CHECK (size >= 0),
  status text NOT NULL CHECK (status IN ('uploading', 'ready')),
  created_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);
CREATE TABLE listing_media (
  listing_id text NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  media_id text NOT NULL REFERENCES media(id),
  ordinal integer NOT NULL,
  PRIMARY KEY (listing_id, ordinal),
  UNIQUE (listing_id, media_id)
);
CREATE INDEX listing_media_media_idx ON listing_media (media_id);
CREATE TABLE comment_notes (
  listing_id text NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  text text NOT NULL,
  source_url text NOT NULL,
  PRIMARY KEY (listing_id, ordinal)
);

-- One row per collection job, from queueing (manual refresh) or first attempt to the result.
-- Collector batches (Facebook) leave the job columns empty.
CREATE TABLE collection_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL REFERENCES sources(id),
  status text NOT NULL,
  counts jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  job_id text UNIQUE,
  trigger text CHECK (trigger IN ('schedule', 'manual', 'catch-up', 'collector')),
  attempts integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz,
  error text
);
CREATE INDEX collection_runs_source_created_idx ON collection_runs (source, created_at DESC);

CREATE TABLE audit_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL,
  listing_id text REFERENCES listings(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The source contract as JSON; presence tracking keeps explicit nulls apart from absent keys.
CREATE VIEW listing_source_records AS
SELECT l.*, l.metadata || jsonb_build_object('id', l.id, 'source', l.source) || coalesce((
  SELECT jsonb_object_agg(p.key, p.value) FROM jsonb_each(jsonb_build_object(
    'title', l.title, 'description', l.description, 'type', l.listing_type,
    'category', l.category, 'venue', l.venue, 'address', l.address,
    'neighbourhood', l.neighbourhood, 'url', l.source_url, 'price', l.price,
    'family', l.family, 'indoor', l.indoor, 'status', l.status, 'start', l.start_date,
    'end', l.end_date, 'schedule', l.schedule_kind
  )) p WHERE p.key = ANY(l.source_fields)
), '{}'::jsonb) AS payload
FROM listings l;

-- The effective document (owner edits applied) is computed on reads, never stored twice.
CREATE VIEW listing_records AS
SELECT r.*,
  r.document->>'title' AS effective_title,
  r.document->>'venue' AS effective_venue,
  r.document->>'category' AS effective_category,
  r.document->>'neighbourhood' AS effective_neighbourhood,
  r.document->>'type' AS effective_type,
  (r.document->>'price')::numeric AS effective_price,
  (r.document->>'family')::boolean AS effective_family,
  (r.document->>'indoor')::boolean AS effective_indoor,
  r.document->>'status' AS effective_status,
  (r.document->>'start')::date AS effective_start_date,
  (r.document->>'end')::date AS effective_end_date
FROM (
  SELECT s.*, ((s.payload || coalesce(o.fields, '{}')) - 'status') ||
    CASE WHEN s.hidden THEN '{"status":"hidden"}'::jsonb
      WHEN 'status' = ANY(s.source_fields) THEN jsonb_build_object('status', s.status)
      ELSE '{}'::jsonb END ||
    jsonb_build_object('id', s.id, 'collection', CASE s.source
      WHEN 'facebook' THEN 'Community Highlights'
      WHEN 'trails-manitoba' THEN 'Official Trails' ELSE '' END) ||
    CASE WHEN loc.details IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('mapLocation', loc.details) END AS document
  FROM listing_source_records s
  LEFT JOIN listing_overrides o ON o.listing_id = s.id
  LEFT JOIN locations loc ON loc.listing_id = s.id
) r;

-- Accounts (Better Auth tables; Winnigo owns authorization in user_access).
CREATE TABLE "auth_user" ("id" text NOT NULL PRIMARY KEY, "name" text NOT NULL,
  "email" text NOT NULL UNIQUE, "emailVerified" boolean NOT NULL, "image" text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE "auth_session" ("id" text NOT NULL PRIMARY KEY, "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE, "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz NOT NULL, "ipAddress" text, "userAgent" text,
  "userId" text NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE);
CREATE TABLE "auth_account" ("id" text NOT NULL PRIMARY KEY, "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL, "updatedAt" timestamptz NOT NULL);
CREATE TABLE "auth_verification" ("id" text NOT NULL PRIMARY KEY, "identifier" text NOT NULL,
  "value" text NOT NULL, "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE "auth_rate_limit" ("id" text NOT NULL PRIMARY KEY, "key" text NOT NULL UNIQUE,
  "count" integer NOT NULL, "lastRequest" bigint NOT NULL);
CREATE INDEX "auth_session_userId_idx" ON "auth_session" ("userId");
CREATE INDEX "auth_account_userId_idx" ON "auth_account" ("userId");
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" ("identifier");

CREATE TABLE user_access (
  user_id text PRIMARY KEY REFERENCES auth_user(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('owner', 'admin', 'user')),
  enabled boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX single_owner ON user_access (role) WHERE role = 'owner';
CREATE TABLE account_invitations (
  email text PRIMARY KEY,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
CREATE TABLE source_grants (
  user_id text REFERENCES auth_user(id) ON DELETE CASCADE,
  source_id text REFERENCES sources(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, source_id)
);
CREATE TABLE listing_grants (
  user_id text REFERENCES auth_user(id) ON DELETE CASCADE,
  listing_id text REFERENCES listings(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, listing_id)
);
CREATE TABLE service_credentials (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  source_id text NOT NULL REFERENCES sources(id),
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE request_limits (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count integer NOT NULL
);
CREATE TABLE security_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL,
  user_id text REFERENCES auth_user(id) ON DELETE SET NULL,
  subject_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Event collection (docs/30). The last fetch of each source page: a page whose prepared content
-- and extraction settings are unchanged reuses its stored model output.
CREATE TABLE source_pages (
  source text NOT NULL REFERENCES sources(id),
  url text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('event', 'listing')),
  content_hash text NOT NULL,
  extraction jsonb,
  outcome text NOT NULL,
  error text,
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (source, url)
);

CREATE TABLE events (
  id text PRIMARY KEY,
  source text NOT NULL REFERENCES sources(id),
  -- Identity within the source: the event page's key or URL, or listing page + title + venue.
  source_key text NOT NULL,
  page_url text NOT NULL,
  event_url text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  venue text,
  address text,
  category text NOT NULL,
  price numeric,
  price_text text,
  availability text,
  ticket_url text,
  organizer_url text,
  -- The source's image, kept for a later private copy; not shown directly.
  image_url text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'gone')),
  hidden boolean NOT NULL DEFAULT false,
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'restricted')),
  -- Unresolved conflicts or schedule problems the model or mapper reported.
  review_notes jsonb NOT NULL DEFAULT '[]',
  evidence jsonb NOT NULL DEFAULT '[]',
  -- Owner corrections, applied over source values when read. `sessions_locked` keeps the
  -- owner's sessions when later runs read different ones.
  owner_edits jsonb NOT NULL DEFAULT '{}',
  sessions_locked boolean NOT NULL DEFAULT false,
  first_seen timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_key)
);
CREATE INDEX events_source_idx ON events (source);

CREATE TABLE event_sessions (
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  id text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  start_at timestamptz,
  end_at timestamptz,
  cancelled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (event_id, id),
  CHECK (end_date >= start_date),
  CHECK (end_at IS NULL OR start_at IS NOT NULL),
  CHECK (end_at IS NULL OR end_at >= start_at)
);
CREATE INDEX event_sessions_dates_idx ON event_sessions (start_date, end_date, event_id)
  WHERE NOT cancelled;

-- Every published change, for review after publication.
CREATE TABLE event_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint REFERENCES collection_runs(id) ON DELETE SET NULL,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('new', 'changed', 'gone')),
  diff jsonb NOT NULL DEFAULT '[]',
  before jsonb,
  after jsonb,
  reviewed_at timestamptz,
  -- The reviewer's principal id (no foreign key: local mode's owner has no account row).
  reviewed_by text,
  reverted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_changes_open_idx ON event_changes (created_at DESC) WHERE reviewed_at IS NULL;
CREATE INDEX event_changes_event_idx ON event_changes (event_id, created_at DESC);
