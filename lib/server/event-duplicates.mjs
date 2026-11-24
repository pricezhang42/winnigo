// Cross-source duplicate events (#66). The same performance is often listed by its organizer
// and by Tourism Winnipeg, Travel Manitoba or Manitoba Music. Discovery shows it once, under
// the most direct source, and lists the others as "also listed by".
//
// Only verified matches are merged: the same title, every session at a precise time that the
// other event also has, and the same place (venue or address) or a shared event, ticket or
// organizer link. A title and day alone, or an unknown time, is not enough: those pairs are
// reported as candidates for review and stay separate. Nothing is deleted; `duplicate_of`
// only hides an event from non-admin readers and is recomputed after every collection run.

// Aggregators, least preferred last. Every other source (organizers and venues) comes first.
const AGGREGATORS = ['manitoba-music', 'tourism-winnipeg', 'manitoba'];

// Words that say nothing about which place it is.
const PLACE_NOISE = new Set(
  'the of and at a in on winnipeg mb manitoba canada centre center theatre theater hall'.split(' '),
);

// Trademark signs go before NFKD, which would turn "™" into "TM".
const normalTitle = (title) =>
  String(title || '')
    .replace(/[™®©]/g, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, '');

// Street-type abbreviations, so "1961 McCreary Rd" and "1961 McCreary Road" agree.
const STREET_WORDS = {
  rd: 'road',
  st: 'street',
  ave: 'avenue',
  av: 'avenue',
  blvd: 'boulevard',
  dr: 'drive',
  cres: 'crescent',
  pl: 'place',
};

const words = (text) =>
  new Set(
    String(text || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((word) => STREET_WORDS[word] || word)
      .filter((word) => word.length > 1 && !PLACE_NOISE.has(word)),
  );

/** Most words of the shorter description also appear in the longer one. */
function overlaps(one, two) {
  if (!one.size || !two.size) return false;
  const shared = [...one].filter((word) => two.has(word)).length;
  return shared / Math.min(one.size, two.size) >= 0.5;
}

/** Whether two events name the same place: by venue, by address, or by both together. */
export function samePlace(a, b) {
  return (
    overlaps(words(a.venue), words(b.venue)) ||
    overlaps(words(a.address), words(b.address)) ||
    overlaps(
      words(`${a.venue || ''} ${a.address || ''}`),
      words(`${b.venue || ''} ${b.address || ''}`),
    )
  );
}

const links = (event) =>
  new Set([event.eventUrl, event.ticketUrl, event.organizerUrl].filter(Boolean));

function sharedLink(a, b) {
  const other = links(b);
  return [...links(a)].some((url) => other.has(url));
}

/** Every session of the event with fewer sessions starts at a precise time the other has. */
function sameSessions(a, b) {
  const [few, many] = a.starts.length <= b.starts.length ? [a, b] : [b, a];
  if (!few.starts.length || few.starts.some((start) => !start)) return false;
  const times = new Set(many.starts.filter(Boolean));
  return few.starts.every((start) => times.has(start));
}

const rank = (event) => [
  event.ownerEdited ? 0 : 1,
  AGGREGATORS.indexOf(event.source) + 1,
  -event.starts.length,
  event.id,
];

function better(a, b) {
  const [x, y] = [rank(a), rank(b)];
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? a : b;
  return a;
}

/**
 * Groups verified duplicates and picks each group's canonical event.
 * @param {Array<{ id: string, source: string, title: string, venue?: string, address?: string,
 *   eventUrl?: string, ticketUrl?: string, organizerUrl?: string, ownerEdited?: boolean,
 *   starts: (string | null)[], days: string[] }>} events current, visible events; `starts`
 *   are session start instants (null when the time is unknown), `days` their local dates
 * @returns {{ duplicates: Map<string, string>, candidates: Array<[string, string]> }}
 *   duplicate id → canonical id, and unverified same-title, same-day pairs
 */
export function findDuplicates(events) {
  const byTitle = new Map();
  for (const event of events) {
    const key = normalTitle(event.title);
    if (!key) continue;
    byTitle.set(key, [...(byTitle.get(key) || []), event]);
  }
  const parent = new Map(events.map((event) => [event.id, event.id]));
  const root = (id) => (parent.get(id) === id ? id : root(parent.get(id)));
  const candidates = [];
  for (const group of byTitle.values())
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = [group[i], group[j]];
        if (a.source === b.source) continue;
        const verified = sameSessions(a, b) && (samePlace(a, b) || sharedLink(a, b));
        if (verified) parent.set(root(a.id), root(b.id));
        else if (a.days.some((day) => b.days.includes(day))) candidates.push([a.id, b.id]);
      }
  const groups = new Map();
  for (const event of events) {
    const key = root(event.id);
    groups.set(key, [...(groups.get(key) || []), event]);
  }
  const duplicates = new Map();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Two events from the same source are separate listings, so a chain that links them is
    // left for review rather than merged.
    if (new Set(group.map((event) => event.source)).size < group.length) {
      for (let i = 1; i < group.length; i++) candidates.push([group[0].id, group[i].id]);
      continue;
    }
    const canonical = group.reduce(better);
    for (const event of group)
      if (event.id !== canonical.id) duplicates.set(event.id, canonical.id);
  }
  return {
    duplicates,
    // Pairs already shown as one event are settled.
    candidates: candidates.filter(
      ([a, b]) => (duplicates.get(a) ?? a) !== (duplicates.get(b) ?? b),
    ),
  };
}

// Current, visible events with owner edits applied: the ones a reader could see twice.
const CURRENT_EVENTS_SQL = `
  SELECT e.id, e.source,
    coalesce(e.owner_edits->>'title', e.title) AS title,
    coalesce(e.owner_edits->>'venue', e.venue) AS venue,
    coalesce(e.owner_edits->>'address', e.address) AS address,
    e.event_url AS "eventUrl", coalesce(e.owner_edits->>'ticket_url', e.ticket_url) AS "ticketUrl",
    e.organizer_url AS "organizerUrl",
    (e.owner_edits <> '{}'::jsonb OR e.sessions_locked) AS "ownerEdited",
    array_agg(to_char(s.start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"')
      ORDER BY s.start_date, s.start_at) AS starts,
    array_agg(s.start_date::text ORDER BY s.start_date, s.start_at) AS days
  FROM events e JOIN event_sessions s ON s.event_id = e.id AND NOT s.cancelled
  WHERE NOT e.hidden AND e.visibility = 'public'
    AND coalesce(e.owner_edits->>'status', e.status) = 'active'
    AND s.end_date >= $1::date
  GROUP BY e.id`;

/**
 * Recomputes `duplicate_of` for every event and moves saved items from a newly hidden duplicate
 * to its canonical event. Returns the number of duplicates and the unverified candidates.
 * @param {import('pg').Pool} pool
 * @param {string} today Winnipeg date (YYYY-MM-DD)
 */
export async function markDuplicateEvents(pool, today) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One recomputation at a time; concurrent source runs wait their turn.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('winnigo:event-duplicates'))");
    const { rows } = await client.query(CURRENT_EVENTS_SQL, [today]);
    const { duplicates, candidates } = findDuplicates(rows);
    const ids = [...duplicates.keys()];
    const canonicals = ids.map((id) => duplicates.get(id));
    await client.query(
      `UPDATE events e SET duplicate_of = m.canonical
         FROM unnest($1::text[], $2::text[]) AS m(id, canonical)
        WHERE e.id = m.id AND e.duplicate_of IS DISTINCT FROM m.canonical`,
      [ids, canonicals],
    );
    await client.query(
      `UPDATE events SET duplicate_of = NULL
        WHERE duplicate_of IS NOT NULL AND NOT (id = ANY($1::text[]))`,
      [ids],
    );
    await client.query(
      `WITH moved AS (
         DELETE FROM saved_items s USING unnest($1::text[], $2::text[]) AS m(id, canonical)
          WHERE s.item_id = m.id RETURNING s.user_id, m.canonical, s.saved_at)
       INSERT INTO saved_items (user_id, item_id, saved_at)
       SELECT user_id, canonical, min(saved_at) FROM moved GROUP BY user_id, canonical
       ON CONFLICT DO NOTHING`,
      [ids, canonicals],
    );
    await client.query('COMMIT');
    return { duplicates: ids.length, candidates };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
