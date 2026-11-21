-- Event collection redesign, step 2 (docs/30). Events collected by AI extraction from the
-- source list are stored here, separately from `listings` (trails, places and community
-- highlights). Changes publish immediately and are recorded for the owner to review.

-- The last fetch of each source page. A page whose prepared content and extraction settings
-- are unchanged reuses its stored model output instead of a new model call.
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
