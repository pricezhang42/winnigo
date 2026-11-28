'use client';
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { dateTimeLabel, timeLabel } from '@/lib/time-zone.mjs';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';

type Diff =
  | { field: string; before: unknown; after: unknown }
  | { field: 'sessions'; added: string[]; removed: string[] };
type Snapshot = Record<string, unknown> & {
  sessions?: { start_date: string; start_at: string | null; cancelled: boolean }[];
};
type Change = {
  id: number;
  kind: 'new' | 'changed' | 'gone';
  diff: Diff[];
  before: Snapshot | null;
  after: Snapshot | null;
  createdAt: string;
  reviewedAt: string | null;
  revertedAt: string | null;
  eventId: string;
  source: string;
  title: string;
  eventUrl: string;
  hidden: boolean;
  status: string;
  reviewNotes: { field: string; reason: string }[];
  ownerEdits: Record<string, string>;
  sessionsLocked: boolean;
};

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  event_kind: 'Event type',
  description: 'Description',
  venue: 'Venue',
  address: 'Address',
  category: 'Category',
  price: 'Price',
  price_text: 'Admission',
  availability: 'Tickets',
  ticket_url: 'Ticket link',
  organizer_url: 'Organizer link',
  image_url: 'Image',
  status: 'Status',
  sessions: 'Sessions',
  review_notes: 'Needs review',
};
const EDITABLE = ['title', 'venue', 'address', 'category', 'price', 'price_text', 'ticket_url'];
const KIND_LABELS = { new: 'New', changed: 'Changed', gone: 'Gone from source' };

// Winnipeg time from the checked-in zone table, not the browser's own time zone data.
const winnipeg = (value: string) => dateTimeLabel(value);
/** "2026-11-21 2026-11-21 2026-11-21T19:45:00.000Z ..." → "Nov 21, 1:45 p.m." */
function sessionLabel(text: string) {
  const [start, end, startAt, endAt] = text.split(' ');
  const cancelled = text.endsWith('cancelled') ? ' (cancelled)' : '';
  const date = (day: string) =>
    new Date(day + 'T12:00:00Z').toLocaleDateString('en-CA', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
    });
  const time = timeLabel(
    startAt?.includes('T') ? startAt : undefined,
    endAt?.includes('T') ? endAt : undefined,
    undefined,
  );
  return (
    date(start) +
    (end && end !== start ? ' – ' + date(end) : '') +
    (time ? ', ' + time : '') +
    cancelled
  );
}
const show = (value: unknown) =>
  value === null || value === undefined || value === '' ? '—' : String(value);

/**
 * Events publish as soon as they are collected; this list is where the owner checks each new,
 * changed or vanished event afterwards and keeps, undoes or corrects it.
 */
export default function EventReview() {
  const [changes, setChanges] = useState<Change[]>([]);
  const [counts, setCounts] = useState({ open: 0, total: 0 });
  const [available, setAvailable] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Change | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/event-changes' + (showAll ? '?all=1' : ''));
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
      setChanges(result.changes);
      setCounts(result.counts);
      setAvailable(result.available);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load event changes.');
    }
  }, [showAll]);
  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const response = await fetch('/api/event-changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
      await load();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That did not work.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!available) return null;
  return (
    <section className="event-review" aria-labelledby="event-review-title">
      <div className="event-review-head">
        <div>
          <h2 id="event-review-title">Collected event changes</h2>
          <p>
            Collected events are published straight away. Check each change here: keep it, undo it,
            or correct the event. {counts.open} of {counts.total} still to check.
          </p>
        </div>
        <Button variant="outline" onClick={() => setShowAll((all) => !all)}>
          {showAll ? 'Show only unchecked' : 'Show checked too'}
        </Button>
      </div>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {!changes.length && <p className="source-note">Nothing to check.</p>}
      <ul className="event-changes">
        {changes.map((change) => (
          <li key={change.id} className={change.reviewedAt ? 'checked' : ''}>
            <div className="event-change-head">
              <span className={`run-status change-${change.kind}`}>{KIND_LABELS[change.kind]}</span>
              <a href={change.eventUrl} target="_blank" rel="noreferrer">
                <strong>{change.title}</strong> <ExternalLink size={13} />
              </a>
              <small>
                {change.source} · {winnipeg(change.createdAt)}
                {change.hidden ? ' · hidden' : ''}
                {change.revertedAt ? ' · undone' : change.reviewedAt ? ' · checked' : ''}
              </small>
            </div>
            <ChangeDetails change={change} />
            {change.reviewNotes.length > 0 && (
              <ul className="review-notes">
                {change.reviewNotes.map((note, i) => (
                  <li key={i}>
                    Needs a look ({note.field.replace(/^\//, '')}): {note.reason}
                  </li>
                ))}
              </ul>
            )}
            <div className="event-change-actions">
              {!change.reviewedAt && (
                <Button
                  disabled={busy}
                  onClick={() => act({ action: 'review', changeId: change.id })}
                >
                  Looks right
                </Button>
              )}
              {!change.revertedAt && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => act({ action: 'revert', changeId: change.id })}
                >
                  {change.kind === 'new'
                    ? 'Undo: hide event'
                    : change.kind === 'gone'
                      ? 'Undo: keep listed'
                      : 'Undo change'}
                </Button>
              )}
              <Button variant="ghost" disabled={busy} onClick={() => setEditing(change)}>
                Correct details
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  act({ action: 'edit', eventId: change.eventId, hidden: !change.hidden })
                }
              >
                {change.hidden ? 'Show event' : 'Hide event'}
              </Button>
              {change.sessionsLocked && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    act({ action: 'edit', eventId: change.eventId, unlockSessions: true })
                  }
                >
                  Let collection update sessions again
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <EditEventDialog
        key={editing?.id ?? 'closed'}
        change={editing}
        busy={busy}
        onClose={() => setEditing(null)}
        onSave={async (fields) => {
          if (editing && (await act({ action: 'edit', eventId: editing.eventId, fields })))
            setEditing(null);
        }}
      />
    </section>
  );
}

function ChangeDetails({ change }: { change: Change }) {
  if (change.kind === 'new') {
    const after = change.after || {};
    const sessions = after.sessions || [];
    return (
      <dl className="event-change-diff">
        {['venue', 'price_text', 'category'].map((field) =>
          after[field] ? (
            <div key={field}>
              <dt>{FIELD_LABELS[field]}</dt>
              <dd>{show(after[field])}</dd>
            </div>
          ) : null,
        )}
        <div>
          <dt>Sessions ({sessions.length})</dt>
          <dd>
            {sessions
              .slice(0, 12)
              .map((s) =>
                sessionLabel(
                  [s.start_date, s.start_date, s.start_at || '', s.cancelled ? 'cancelled' : '']
                    .filter(Boolean)
                    .join(' '),
                ),
              )
              .join(' · ') || 'None in this or next month'}
            {sessions.length > 12 ? ` · and ${sessions.length - 12} more` : ''}
          </dd>
        </div>
      </dl>
    );
  }
  return (
    <dl className="event-change-diff">
      {change.diff.map((d) => (
        <div key={d.field}>
          <dt>{FIELD_LABELS[d.field] || d.field}</dt>
          {'added' in d ? (
            <dd>
              {d.added.length > 0 && (
                <span className="added">Added: {d.added.map(sessionLabel).join(' · ')}</span>
              )}
              {d.removed.length > 0 && (
                <span className="removed">Removed: {d.removed.map(sessionLabel).join(' · ')}</span>
              )}
            </dd>
          ) : (
            <dd>
              <span className="removed">{show(d.before)}</span> →{' '}
              <span className="added">{show(d.after)}</span>
            </dd>
          )}
        </div>
      ))}
    </dl>
  );
}

function EditEventDialog({
  change,
  busy,
  onClose,
  onSave,
}: {
  change: Change | null;
  busy: boolean;
  onClose: () => void;
  onSave: (fields: Record<string, string | null>) => void;
}) {
  // Remounted per change (see `key`), so the form starts from that event's current values.
  const [values, setValues] = useState<Record<string, string>>(() => {
    if (!change) return {};
    const current = change.after || change.before || {};
    return Object.fromEntries(
      [...EDITABLE, 'event_kind', 'description'].map((field) => [
        field,
        change.ownerEdits[field] ??
          (current[field] == null
            ? field === 'event_kind'
              ? 'event'
              : ''
            : String(current[field])),
      ]),
    );
  });
  if (!change) return null;
  const source = change.after || change.before || {};
  const fields = () =>
    Object.fromEntries(
      Object.entries(values).map(([field, value]) => {
        const original =
          source[field] == null ? (field === 'event_kind' ? 'event' : '') : String(source[field]);
        // Matching the source value again removes the correction.
        return [field, value === original ? null : value];
      }),
    );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="detail-dialog">
        <DialogTitle>Correct event details</DialogTitle>
        <DialogDescription>
          Corrections are kept when the source is collected again. Clear a change by typing the
          collected value back in.
        </DialogDescription>
        <form
          className="edit-event-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSave(fields());
          }}
        >
          <label>
            Event type
            <select
              value={values.event_kind}
              onChange={(event) => setValues({ ...values, event_kind: event.target.value })}
            >
              <option value="event">Event</option>
              <option value="class">Class</option>
            </select>
          </label>
          {EDITABLE.map((field) => (
            <label key={field}>
              {FIELD_LABELS[field]}
              <Input
                value={values[field] ?? ''}
                inputMode={field === 'price' ? 'decimal' : undefined}
                onChange={(event) => setValues({ ...values, [field]: event.target.value })}
              />
            </label>
          ))}
          <label>
            {FIELD_LABELS.description}
            <Textarea
              rows={5}
              value={values.description ?? ''}
              onChange={(event) => setValues({ ...values, description: event.target.value })}
            />
          </label>
          <div className="detail-actions">
            <Button type="submit" disabled={busy}>
              Save corrections
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
