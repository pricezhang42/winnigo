'use client';
import SocialOutingForm from '@/components/social-outing-form';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, RefreshCw, ExternalLink, Search, EyeOff, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

type Item = {
  id: string;
  title: string;
  description: string;
  sourceName: string;
  start?: string;
  status: string;
  url: string;
  price: number | null;
};
type Report = {
  id: string;
  name: string;
  count: number;
  status: string;
  checkedAt: string;
  error?: string;
};
type Data = {
  total?: number;
  items: Item[];
  sources: Report[];
  communitySources?: Report[];
  error?: string;
};

const PAGE_SIZE = 50;

type Run = {
  id: number;
  source: string;
  status: string;
  trigger: string | null;
  attempts: number;
  counts: Partial<
    Record<
      | 'found'
      | 'added'
      | 'updated'
      | 'unchanged'
      | 'cancelled'
      | 'merged'
      | 'rejected'
      | 'pages'
      | 'eventPages',
      number
    >
  >;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};
const ACTIVE_RUN = ['queued', 'running', 'retrying'];
const RUN_POLL_MS = 5000;

/** Collection desk: source status, the social-outing form, and listing corrections. */
export default function Admin() {
  const [data, setData] = useState<Data>({ items: [], sources: [] });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Item | null>(null);
  const [offset, setOffset] = useState(0);
  const [notice, setNotice] = useState('');
  const [runsVersion, setRunsVersion] = useState(0);
  const [collectionAvailable, setCollectionAvailable] = useState(false);
  // Ignores responses from loads that a newer load has superseded.
  const loadVersion = useRef(0);

  async function load() {
    const version = ++loadVersion.current;
    try {
      const response = await fetch(
        '/api/sources?' +
          new URLSearchParams({ query, offset: String(offset), limit: String(PAGE_SIZE) }),
      );
      const page = (await response.json()) as Data;
      if (!response.ok) throw Error(page.error);
      if (version === loadVersion.current) setData(page);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load listings.');
    }
  }

  useEffect(() => {
    const timer = setTimeout(load, 100);
    return () => clearTimeout(timer);
  }, [query, offset]);

  /** Sends an admin action, then reloads the list and closes the editor on success. */
  async function action(payload: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as Data;
      if (!response.ok) throw Error(result.error);
      await load();
      setEditing(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  /** Queues collection for every public source; the run history shows progress. */
  async function refresh() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh' }),
      });
      const result = (await response.json()) as {
        error?: string;
        queued?: { sourceId: string; alreadyQueued?: boolean }[];
      };
      if (!response.ok) throw Error(result.error);
      const queued = result.queued || [];
      const waiting = queued.filter((entry) => entry.alreadyQueued).length;
      setNotice(
        `Queued ${queued.length - waiting} source check${queued.length - waiting === 1 ? '' : 's'}` +
          (waiting ? ` (${waiting} already waiting)` : '') +
          '. Results appear in the run history.',
      );
      setRunsVersion((version) => version + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not queue a refresh.');
    } finally {
      setBusy(false);
    }
  }

  const reports = [
    ...data.sources,
    ...(data.communitySources || []).filter((source) => source.id === 'facebook'),
  ];

  return (
    <main className="admin-page">
      <a href="/" className="back-link">
        <ArrowLeft size={16} /> Back to Winnigo
      </a>
      <div className="results-heading">
        <div>
          <div className="eyebrow">WINNIGO · COLLECTION DESK</div>
          <h1>Keep the good things current.</h1>
          <p>Review sources, correct details, and hide duplicate or cancelled listings.</p>
        </div>
        <Button disabled={busy} onClick={refresh}>
          <RefreshCw size={16} />
          {busy ? 'Working…' : 'Refresh sources'}
        </Button>
      </div>
      <p className="source-note">
        {collectionAvailable
          ? 'Public sources are collected by the background worker on a schedule. Refresh queues a check now; your corrections are always kept.'
          : 'This development collection uses saved snapshots. Your corrections are stored locally. Automatic collection needs the PostgreSQL repository and the worker.'}
      </p>
      {notice && (
        <p className="success-note" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}{' '}
          <Button variant="ghost" onClick={load}>
            Retry
          </Button>
        </p>
      )}
      <SocialOutingForm onAdded={load} />
      <RunHistory version={runsVersion} onAvailable={setCollectionAvailable} onSettled={load} />
      <div className="admin-sources">
        {reports.map((report) => (
          <SourceStatus key={report.id} report={report} />
        ))}
      </div>
      <div className="search-row">
        <Search size={18} />
        <Input
          aria-label="Search collection"
          placeholder="Search collection…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOffset(0);
          }}
        />
      </div>
      <div className="admin-list">
        {data.items.map((item) => (
          <ListingRow
            key={item.id}
            item={item}
            busy={busy}
            onEdit={() => setEditing({ ...item })}
            onToggleHidden={() =>
              action({ action: 'update', id: item.id, hidden: item.status !== 'hidden' })
            }
          />
        ))}
      </div>
      <div>
        <Button
          variant="outline"
          disabled={offset === 0}
          onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
        >
          Previous
        </Button>
        <span> {data.total || 0} listings </span>
        <Button
          variant="outline"
          disabled={offset + data.items.length >= (data.total || 0)}
          onClick={() => setOffset((current) => current + PAGE_SIZE)}
        >
          Next
        </Button>
      </div>
      <EditListingDialog
        item={editing}
        busy={busy}
        onChange={setEditing}
        onSave={(item) => action({ action: 'update', ...item })}
      />
    </main>
  );
}

/**
 * Recent collection runs. Polls while any run is queued, running or retrying, and calls
 * `onSettled` once they finish so the source cards refresh.
 */
function RunHistory({
  version,
  onAvailable,
  onSettled,
}: {
  version: number;
  onAvailable: (available: boolean) => void;
  onSettled: () => void;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [available, setAvailable] = useState(false);
  const wasActive = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const response = await fetch('/api/runs');
        if (!response.ok) return;
        const result = (await response.json()) as { runs: Run[]; available: boolean };
        if (cancelled) return;
        setRuns(result.runs);
        setAvailable(result.available);
        onAvailable(result.available);
        const active = result.runs.some((run) => ACTIVE_RUN.includes(run.status));
        if (wasActive.current && !active) onSettled();
        wasActive.current = active;
        if (active) timer = setTimeout(poll, RUN_POLL_MS);
      } catch {
        // Run history is informational; the next refresh or page load retries.
      }
    }
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Callbacks come from the parent's state setters and load(); polling restarts per refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  if (!available) return null;
  return (
    <section className="run-history" aria-label="Collection runs">
      <h2>Collection runs</h2>
      {runs.length === 0 ? (
        <p className="source-note">No runs yet. Use Refresh sources or enable schedules.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Status</th>
              <th>Trigger</th>
              <th>Started</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {runs.slice(0, 20).map((run) => (
              <tr key={run.id}>
                <td>{run.source}</td>
                <td>
                  <span className={'run-status run-' + run.status}>{run.status}</span>
                  {run.attempts > 1 ? ` (attempt ${run.attempts})` : ''}
                </td>
                <td>{run.trigger || 'collector'}</td>
                <td>{formatTime(run.startedAt || run.createdAt)}</td>
                <td>
                  {summarizeCounts(run.counts)}
                  {run.error && (
                    <span className="run-note">
                      {run.status === 'error' || run.status === 'retrying' ? '' : ' — '}
                      {run.error}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const formatTime = (value: string) =>
  new Date(value).toLocaleString('en-CA', { timeZone: 'America/Winnipeg' });

function summarizeCounts(counts: Run['counts']) {
  if (counts.found === undefined) return '';
  const parts = [
    `${counts.found} found`,
    `${counts.added || 0} new`,
    `${counts.updated || 0} changed`,
  ];
  if (counts.cancelled) parts.push(`${counts.cancelled} cancelled`);
  if (counts.merged) parts.push(`${counts.merged} duplicates merged`);
  if (counts.rejected) parts.push(`${counts.rejected} rejected`);
  if (counts.pages && counts.pages > 1) parts.push(`${counts.pages} pages`);
  if (counts.eventPages) parts.push(`${counts.eventPages} event pages`);
  return parts.join(' · ');
}

function SourceStatus({ report }: { report: Report }) {
  return (
    <div>
      <span className="eyebrow">
        {report.status === 'ok'
          ? 'COLLECTED'
          : report.status === 'pending'
            ? 'AWAITING FIRST CHECK'
            : 'NEEDS ATTENTION'}
      </span>
      <h3>{report.name}</h3>
      <p>{report.count} listings</p>
      <small>
        {report.checkedAt
          ? 'Checked ' +
            new Date(report.checkedAt).toLocaleString('en-CA', { timeZone: 'America/Winnipeg' })
          : 'No successful check yet'}
      </small>
      {report.error && <p className="notice">{report.error}</p>}
    </div>
  );
}

function ListingRow({
  item,
  busy,
  onEdit,
  onToggleHidden,
}: {
  item: Item;
  busy: boolean;
  onEdit: () => void;
  onToggleHidden: () => void;
}) {
  const hidden = item.status === 'hidden';
  return (
    <div>
      <div>
        <strong>{item.title}</strong>
        <p>
          {item.sourceName} · {item.start || 'Year-round'} · {hidden ? 'Hidden' : 'Visible'}
        </p>
      </div>
      <a href={item.url} target="_blank" rel="noreferrer" aria-label={'Source for ' + item.title}>
        <ExternalLink size={17} />
      </a>
      <Button variant="outline" onClick={onEdit}>
        Edit
      </Button>
      <Button
        disabled={busy}
        variant="ghost"
        aria-label={(hidden ? 'Show ' : 'Hide ') + item.title}
        onClick={onToggleHidden}
      >
        {hidden ? <Eye /> : <EyeOff />}
      </Button>
    </div>
  );
}

/**
 * Editorial corrections. They are saved as owner overrides, separate from the source data,
 * so later imports never overwrite them.
 */
function EditListingDialog({
  item,
  busy,
  onChange,
  onSave,
}: {
  item: Item | null;
  busy: boolean;
  onChange: (item: Item | null) => void;
  onSave: (item: Item) => void;
}) {
  return (
    <Dialog
      open={!!item}
      onOpenChange={(open) => {
        if (!open) onChange(null);
      }}
    >
      <DialogContent>
        <DialogTitle>Correct listing details</DialogTitle>
        <DialogDescription>Corrections stay in place when the source refreshes.</DialogDescription>
        {item && (
          <>
            <label htmlFor="edit-title">Title</label>
            <Input
              id="edit-title"
              value={item.title}
              onChange={(event) => onChange({ ...item, title: event.target.value })}
            />
            <label htmlFor="edit-description">Description</label>
            <Textarea
              id="edit-description"
              value={item.description}
              onChange={(event) => onChange({ ...item, description: event.target.value })}
            />
            <label htmlFor="edit-price">Admission in CAD (leave blank if unknown)</label>
            <Input
              id="edit-price"
              type="number"
              min="0"
              value={item.price ?? ''}
              onChange={(event) =>
                onChange({
                  ...item,
                  price: event.target.value === '' ? null : Number(event.target.value),
                })
              }
            />
            <Button disabled={busy || !item.title.trim()} onClick={() => onSave(item)}>
              {busy ? 'Saving…' : 'Save corrections'}
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
