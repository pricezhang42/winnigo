// Publishing extracted events (docs/30, step 2). A run's events are written immediately; every
// new, changed or vanished event is recorded in event_changes for the owner to review, revert
// or correct afterwards. Owner corrections live in owner_edits and survive later runs.
import { createHash } from 'node:crypto';
import { collectionWindow } from '../event-schedule.mjs';
import { localDay } from '../connectors.mjs';
import { markDuplicateEvents } from './event-duplicates.mjs';
import { writeTransaction } from './postgres.mjs';
import { validateSource } from './event-sources.mjs';

const FIELDS = [
  'title',
  'description',
  'venue',
  'address',
  'category',
  'price',
  'price_text',
  'availability',
  'ticket_url',
  'organizer_url',
  'image_url',
  'status',
];
/** Fields the owner may correct. */
export const EDITABLE_FIELDS = [
  'title',
  'description',
  'venue',
  'address',
  'category',
  'price',
  'price_text',
  'ticket_url',
];

const hash = (value) => createHash('sha256').update(value).digest('hex');
export const eventId = (source, key) => `${source}-${hash(key).slice(0, 16)}`;
const iso = (value) => (value ? new Date(value).toISOString() : null);
const sessionId = (s) => (s.start_at ? iso(s.start_at) : s.start_date);
const sessionText = (s) =>
  [s.start_date, s.end_date, iso(s.start_at), iso(s.end_at), s.cancelled ? 'cancelled' : '']
    .filter(Boolean)
    .join(' ');
const sameValue = (a, b) =>
  a === b || (a !== null && b !== null && a !== undefined && String(a) === String(b));

/** Stored model output by page URL, for pages whose content hash is unchanged. */
export async function storedExtractions(pool, source) {
  const { rows } = await pool.query(
    'SELECT url, content_hash, extraction FROM source_pages WHERE source=$1 AND extraction IS NOT NULL',
    [source],
  );
  const byUrl = new Map(rows.map((row) => [row.url, row]));
  return async (url, contentHash) => {
    const row = byUrl.get(url);
    return row?.content_hash === contentHash ? row.extraction : null;
  };
}

/** Database row values for one extracted event. */
function eventRow(config, page, e) {
  const fallback = e.venueFallback;
  return {
    title: e.title?.trim() || null,
    description: e.description || '',
    venue: e.venue || fallback?.name || null,
    address: e.address || fallback?.address || null,
    category: e.category,
    price: e.price?.amount ?? null,
    price_text: e.price?.text ?? null,
    availability: e.availability ?? null,
    ticket_url: e.ticketUrl ?? null,
    organizer_url: e.organizerUrl ?? null,
    image_url: e.images[0] ?? null,
    status: e.status === 'cancelled' ? 'cancelled' : 'active',
    page_url: page.url,
    event_url: e.url,
    review_notes: [
      ...e.reviewReasons.map((r) => ({ field: r.field, reason: r.reason })),
      ...(e.scheduleError ? [{ field: '/schedule', reason: e.scheduleError }] : []),
    ],
    evidence: e.evidence,
    sessions: e.sessions.map((s) => ({
      start_date: s.start,
      end_date: s.end,
      start_at: s.startAt,
      end_at: s.endAt,
      cancelled: s.status === 'cancelled',
    })),
  };
}

/** One event per key: entries for the same event on several pages share their sessions. */
function mergeEvents(config, result) {
  const merged = new Map();
  for (const page of result.pages)
    for (const e of page.events) {
      const row = eventRow(config, page, e);
      if (!row.title) continue;
      const known = merged.get(e.key);
      if (!known) {
        merged.set(e.key, row);
        continue;
      }
      for (const field of FIELDS) if (known[field] == null) known[field] = row[field];
      for (const s of row.sessions)
        if (!known.sessions.some((k) => sessionId(k) === sessionId(s))) known.sessions.push(s);
      known.review_notes.push(...row.review_notes);
    }
  return merged;
}

/** Field and session differences between two snapshots (sessions compared inside the window). */
export function diffEvents(before, after) {
  const diff = [];
  for (const field of FIELDS)
    if (!sameValue(before?.[field] ?? null, after?.[field] ?? null))
      diff.push({ field, before: before?.[field] ?? null, after: after?.[field] ?? null });
  const was = new Set((before?.sessions || []).map(sessionText));
  const now = new Set((after?.sessions || []).map(sessionText));
  const added = [...now].filter((s) => !was.has(s)).sort();
  const removed = [...was].filter((s) => !now.has(s)).sort();
  if (added.length || removed.length) diff.push({ field: 'sessions', added, removed });
  return diff;
}

const snapshot = (row, sessions) => ({
  ...Object.fromEntries(FIELDS.map((f) => [f, row[f] ?? null])),
  sessions: sessions.map((s) => ({
    start_date: typeof s.start_date === 'string' ? s.start_date : iso(s.start_date).slice(0, 10),
    end_date: typeof s.end_date === 'string' ? s.end_date : iso(s.end_date).slice(0, 10),
    start_at: iso(s.start_at),
    end_at: iso(s.end_at),
    cancelled: Boolean(s.cancelled),
  })),
});

async function replaceSessions(client, id, sessions, windowFrom) {
  // Sessions before the window are history the current pages no longer show; keep them.
  await client.query('DELETE FROM event_sessions WHERE event_id=$1 AND end_date >= $2', [
    id,
    windowFrom,
  ]);
  for (const s of sessions)
    await client.query(
      `INSERT INTO event_sessions(event_id,id,start_date,end_date,start_at,end_at,cancelled)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (event_id,id) DO UPDATE SET
       start_date=excluded.start_date,end_date=excluded.end_date,start_at=excluded.start_at,
       end_at=excluded.end_at,cancelled=excluded.cancelled`,
      [id, sessionId(s), s.start_date, s.end_date, s.start_at, s.end_at, s.cancelled],
    );
}

async function windowSessions(client, id, windowFrom) {
  return (
    await client.query(
      `SELECT start_date::text,end_date::text,start_at,end_at,cancelled FROM event_sessions
       WHERE event_id=$1 AND end_date >= $2 ORDER BY start_date,start_at NULLS FIRST`,
      [id, windowFrom],
    )
  ).rows;
}

/**
 * Publish one run's extraction. Pages that failed or were skipped protect their events from
 * being marked gone; so does an incomplete crawl for events whose page was not read at all.
 * Returns counts for the run record.
 */
export async function publishCollection(pool, definition, crawl, result, { runId = null } = {}) {
  const config = validateSource(definition);
  const checkedAt = result.checkedAt;
  const windowFrom = collectionWindow(checkedAt).from;
  const today = localDay(new Date(checkedAt));
  const merged = mergeEvents(config, result);
  const readPages = new Set(
    result.pages.filter((p) => !['failed', 'skipped'].includes(p.outcome)).map((p) => p.url),
  );
  const seen = new Set([...merged.keys(), ...result.pages.flatMap((p) => p.outsideKeys || [])]);
  const crawlComplete =
    !crawl.failedPages.length && !result.pages.some((p) => !readPages.has(p.url));
  const counts = { new: 0, changed: 0, unchanged: 0, gone: 0, reused: result.counts.reused || 0 };

  await writeTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO sources(id, report) VALUES ($1, '{}') ON CONFLICT (id) DO NOTHING`,
      [config.id],
    );
    for (const page of result.pages) {
      if (!page.hash) continue;
      await client.query(
        `INSERT INTO source_pages(source,url,kind,content_hash,extraction,outcome,error,fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (source,url) DO UPDATE SET
         kind=excluded.kind,content_hash=excluded.content_hash,
         extraction=coalesce(excluded.extraction,source_pages.extraction),outcome=excluded.outcome,
         error=excluded.error,fetched_at=excluded.fetched_at`,
        [
          config.id,
          page.url,
          page.kind,
          page.hash,
          page.outcome === 'failed' ? null : (page.raw ?? null),
          page.outcome,
          page.reason ?? null,
          checkedAt,
        ],
      );
    }

    const existing = new Map(
      (await client.query('SELECT * FROM events WHERE source=$1', [config.id])).rows.map((row) => [
        row.source_key,
        row,
      ]),
    );
    const record = (id, kind, diff, before, after) =>
      client.query(
        'INSERT INTO event_changes(run_id,event_id,kind,diff,before,after) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          runId,
          id,
          kind,
          JSON.stringify(diff),
          before && JSON.stringify(before),
          after && JSON.stringify(after),
        ],
      );

    for (const [key, row] of merged) {
      const old = existing.get(key);
      const id = old?.id || eventId(config.id, key);
      const values = [
        row.title,
        row.description,
        row.venue,
        row.address,
        row.category,
        row.price,
        row.price_text,
        row.availability,
        row.ticket_url,
        row.organizer_url,
        row.image_url,
        row.status,
        row.page_url,
        row.event_url,
        JSON.stringify(row.review_notes),
        JSON.stringify(row.evidence),
        checkedAt,
      ];
      if (!old) {
        await client.query(
          `INSERT INTO events(id,source,source_key,title,description,venue,address,category,price,
             price_text,availability,ticket_url,organizer_url,image_url,status,page_url,event_url,
             review_notes,evidence,checked_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [id, config.id, key, ...values],
        );
        await replaceSessions(client, id, row.sessions, windowFrom);
        await record(id, 'new', [], null, snapshot(row, row.sessions));
        counts.new++;
        continue;
      }
      const beforeSessions = await windowSessions(client, id, windowFrom);
      const before = snapshot(old, beforeSessions);
      const afterSessions = old.sessions_locked ? beforeSessions : row.sessions;
      const after = snapshot(row, afterSessions);
      const diff = diffEvents(before, after);
      await client.query(
        `UPDATE events SET title=$2,description=$3,venue=$4,address=$5,category=$6,price=$7,
           price_text=$8,availability=$9,ticket_url=$10,organizer_url=$11,image_url=$12,status=$13,
           page_url=$14,event_url=$15,review_notes=$16,evidence=$17,checked_at=$18
           ${diff.length ? ',updated_at=now()' : ''}
         WHERE id=$1`,
        [id, ...values],
      );
      if (!old.sessions_locked) await replaceSessions(client, id, row.sessions, windowFrom);
      if (diff.length) {
        await record(id, 'changed', diff, before, after);
        counts.changed++;
      } else counts.unchanged++;
    }

    for (const [key, old] of existing) {
      if (seen.has(key) || old.status === 'gone') continue;
      // Only a page read in full this run, or a complete crawl, can show an event is gone.
      if (!readPages.has(old.page_url) && !crawlComplete) continue;
      const sessions = await windowSessions(client, old.id, windowFrom);
      await client.query(`UPDATE events SET status='gone',updated_at=now() WHERE id=$1`, [old.id]);
      // An event whose sessions are all over has simply ended; no review is needed.
      if (sessions.some((s) => s.end_date >= today)) {
        await record(
          old.id,
          'gone',
          [{ field: 'status', before: old.status, after: 'gone' }],
          snapshot(old, sessions),
          null,
        );
        counts.gone++;
      }
    }

    const active = (
      await client.query(
        `SELECT count(*)::int AS n FROM events WHERE source=$1 AND status<>'gone'`,
        [config.id],
      )
    ).rows[0].n;
    const status = result.counts.failed || crawl.failedPages.length ? 'partial' : 'ok';
    await client.query(
      `INSERT INTO sources(id, report) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET report = sources.report || excluded.report`,
      [
        config.id,
        {
          id: config.id,
          checkedAt,
          attemptedAt: checkedAt,
          count: active,
          status,
          error:
            status === 'ok'
              ? null
              : `${result.counts.failed + crawl.failedPages.length} page(s) failed`,
        },
      ],
    );
  });
  return counts;
}

/** Start and finish a collection_runs row around a manual publish. */
export async function startRun(pool, source, trigger = 'manual') {
  await pool.query(
    `INSERT INTO sources(id, report) VALUES ($1, '{}') ON CONFLICT (id) DO NOTHING`,
    [source],
  );
  const { rows } = await pool.query(
    `INSERT INTO collection_runs(source,status,trigger,started_at) VALUES ($1,'running',$2,now()) RETURNING id`,
    [source, trigger],
  );
  return rows[0].id;
}
export async function finishRun(pool, id, status, counts, error = null) {
  await pool.query(
    'UPDATE collection_runs SET status=$2,counts=$3,error=$4,finished_at=now() WHERE id=$1',
    [id, status, counts, error],
  );
}

// ---- Review after publication ----------------------------------------------------------------

export class ReviewError extends Error {}

/** Published changes, newest first; `open` limits them to ones not yet reviewed. */
export async function listChanges(pool, { open = true, limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT c.id::int AS id, c.kind, c.diff, c.before, c.after, c.created_at AS "createdAt",
       c.reviewed_at AS "reviewedAt", c.reverted_at AS "revertedAt", c.run_id::int AS "runId",
       e.id AS "eventId", e.source, coalesce(e.owner_edits->>'title', e.title) AS title,
       e.event_url AS "eventUrl", e.hidden, e.status, e.review_notes AS "reviewNotes",
       e.owner_edits AS "ownerEdits", e.sessions_locked AS "sessionsLocked"
     FROM event_changes c JOIN events e ON e.id = c.event_id
     ${open ? 'WHERE c.reviewed_at IS NULL' : ''}
     ORDER BY c.created_at DESC, c.id DESC LIMIT $1`,
    [Math.min(500, Math.max(1, limit))],
  );
  const counts = (
    await pool.query(
      `SELECT count(*) FILTER (WHERE reviewed_at IS NULL)::int AS open, count(*)::int AS total
       FROM event_changes`,
    )
  ).rows[0];
  return { changes: rows, counts };
}

async function changeFor(client, id) {
  const row = (
    await client.query(
      `SELECT c.*, e.owner_edits FROM event_changes c JOIN events e ON e.id=c.event_id
       WHERE c.id=$1 FOR UPDATE OF c`,
      [id],
    )
  ).rows[0];
  if (!row) throw new ReviewError('Change not found');
  return row;
}

/** Mark a change as reviewed: the published version stands. */
export async function reviewChange(pool, id, userId) {
  return writeTransaction(pool, async (client) => {
    await changeFor(client, id);
    await client.query(
      'UPDATE event_changes SET reviewed_at=now(), reviewed_by=$2 WHERE id=$1 AND reviewed_at IS NULL',
      [id, userId],
    );
  });
}

/**
 * Undo a published change. A new event is hidden. A change restores the previous values as
 * owner edits (and the previous sessions, which later runs then leave alone). A vanished event
 * stays listed. The change counts as reviewed.
 */
export async function revertChange(pool, id, userId, checkedAt = new Date().toISOString()) {
  const result = await writeTransaction(pool, async (client) => {
    const change = await changeFor(client, id);
    if (change.reverted_at) throw new ReviewError('This change was already undone');
    const edits = { ...change.owner_edits };
    if (change.kind === 'new') {
      await client.query('UPDATE events SET hidden=true, updated_at=now() WHERE id=$1', [
        change.event_id,
      ]);
    } else if (change.kind === 'gone') {
      edits.status = 'active';
    } else {
      for (const d of change.diff) {
        if (d.field === 'sessions') continue;
        if (d.field === 'image_url' || d.field === 'availability' || d.field === 'organizer_url')
          continue; // not shown as editable values; the next run sets them again
        edits[d.field] = d.before === null ? '' : String(d.before);
      }
      if (change.diff.some((d) => d.field === 'sessions')) {
        await replaceSessions(
          client,
          change.event_id,
          change.before.sessions,
          collectionWindow(checkedAt).from,
        );
        await client.query('UPDATE events SET sessions_locked=true WHERE id=$1', [change.event_id]);
      }
    }
    await client.query('UPDATE events SET owner_edits=$2, updated_at=now() WHERE id=$1', [
      change.event_id,
      JSON.stringify(edits),
    ]);
    await client.query(
      `UPDATE event_changes SET reverted_at=now(), reviewed_at=coalesce(reviewed_at,now()),
         reviewed_by=coalesce(reviewed_by,$2) WHERE id=$1`,
      [id, userId],
    );
  });
  // An edit can make an event match another source's, or stop matching (#66).
  await markDuplicateEvents(pool, localDay());
  return result;
}

/**
 * Owner corrections. A field set to null removes the correction (the source value shows again);
 * `hidden` hides or shows the event; `unlockSessions` lets later runs replace sessions again.
 * @param {import('pg').Pool} pool
 * @param {string} eventId
 * @param {{ fields?: Record<string, string | null>, hidden?: boolean, unlockSessions?: boolean }} [changes]
 */
export async function editEvent(pool, eventId, { fields = {}, hidden, unlockSessions } = {}) {
  const result = await writeTransaction(pool, async (client) => {
    const row = (
      await client.query('SELECT owner_edits FROM events WHERE id=$1 FOR UPDATE', [eventId])
    ).rows[0];
    if (!row) throw new ReviewError('Event not found');
    const edits = { ...row.owner_edits };
    for (const [field, value] of Object.entries(fields)) {
      if (!EDITABLE_FIELDS.includes(field) && field !== 'status')
        throw new ReviewError(`${field} cannot be edited`);
      if (field === 'status' && value !== null && !['active', 'cancelled'].includes(value))
        throw new ReviewError('Status must be active or cancelled');
      if (value === null) delete edits[field];
      else if (typeof value !== 'string' || value.length > (field === 'description' ? 5000 : 500))
        throw new ReviewError(`Invalid ${field}`);
      else if (field === 'title' && !value.trim()) throw new ReviewError('A title is required');
      else if (field === 'price' && value !== '' && !/^\d+(?:\.\d{1,2})?$/.test(value))
        throw new ReviewError('Price must be a number');
      else edits[field] = value;
    }
    await client.query(
      `UPDATE events SET owner_edits=$2, hidden=coalesce($3, hidden),
         sessions_locked = CASE WHEN $4 THEN false ELSE sessions_locked END, updated_at=now()
       WHERE id=$1`,
      [
        eventId,
        JSON.stringify(edits),
        typeof hidden === 'boolean' ? hidden : null,
        !!unlockSessions,
      ],
    );
  });
  // An edit can make an event match another source's, or stop matching (#66).
  await markDuplicateEvents(pool, localDay());
  return result;
}
