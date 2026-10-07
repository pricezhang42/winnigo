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
export default function Admin() {
  const [data, setData] = useState<Data>({ items: [], sources: [] }),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(''),
    [edit, setEdit] = useState<Item | null>(null),
    [offset, setOffset] = useState(0);
  const loadVersion = useRef(0);
  async function load() {
    const version = ++loadVersion.current;
    try {
      const r = await fetch(
        '/api/sources?' + new URLSearchParams({ query, offset: String(offset), limit: '50' }),
      );
      const d = (await r.json()) as Data;
      if (!r.ok) throw Error(d.error);
      if (version === loadVersion.current) setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load listings.');
    }
  }
  useEffect(() => {
    const timer = setTimeout(load, 100);
    return () => clearTimeout(timer);
  }, [query, offset]);
  async function action(payload: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = (await r.json()) as Data;
      if (!r.ok) throw Error(d.error);
      await load();
      setEdit(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }
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
        <Button disabled={busy} onClick={() => action({ action: 'refresh' })}>
          <RefreshCw size={16} />
          {busy ? 'Working…' : 'Refresh sources'}
        </Button>
      </div>
      <p className="source-note">
        This development collection uses saved snapshots. Your corrections are stored locally.
        Automatic collection will be available after the collection worker is connected.
      </p>
      {error && (
        <p className="notice" role="alert">
          {error}{' '}
          <Button variant="ghost" onClick={load}>
            Retry
          </Button>
        </p>
      )}
      <SocialOutingForm onAdded={load} />
      <div className="admin-sources">
        {[...data.sources, ...(data.communitySources || []).filter((s) => s.id === 'facebook')].map(
          (s) => (
            <div key={s.id}>
              <span className="eyebrow">
                {s.status === 'ok'
                  ? 'COLLECTED'
                  : s.status === 'pending'
                    ? 'AWAITING FIRST CHECK'
                    : 'NEEDS ATTENTION'}
              </span>
              <h3>{s.name}</h3>
              <p>{s.count} listings</p>
              <small>
                {s.checkedAt
                  ? 'Checked ' +
                    new Date(s.checkedAt).toLocaleString('en-CA', { timeZone: 'America/Winnipeg' })
                  : 'No successful check yet'}
              </small>
              {s.error && <p className="notice">{s.error}</p>}
            </div>
          ),
        )}
      </div>
      <div className="search-row">
        <Search size={18} />
        <Input
          aria-label="Search collection"
          placeholder="Search collection…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOffset(0);
          }}
        />
      </div>
      <div className="admin-list">
        {data.items.map((i) => (
          <div key={i.id}>
            <div>
              <strong>{i.title}</strong>
              <p>
                {i.sourceName} · {i.start || 'Year-round'} ·{' '}
                {i.status === 'hidden' ? 'Hidden' : 'Visible'}
              </p>
            </div>
            <a href={i.url} target="_blank" rel="noreferrer" aria-label={'Source for ' + i.title}>
              <ExternalLink size={17} />
            </a>
            <Button variant="outline" onClick={() => setEdit({ ...i })}>
              Edit
            </Button>
            <Button
              disabled={busy}
              variant="ghost"
              aria-label={(i.status === 'hidden' ? 'Show ' : 'Hide ') + i.title}
              onClick={() => action({ action: 'update', id: i.id, hidden: i.status !== 'hidden' })}
            >
              {i.status === 'hidden' ? <Eye /> : <EyeOff />}
            </Button>
          </div>
        ))}
      </div>
      <div>
        <Button
          variant="outline"
          disabled={offset === 0}
          onClick={() => setOffset((n) => Math.max(0, n - 50))}
        >
          Previous
        </Button>
        <span> {data.total || 0} listings </span>
        <Button
          variant="outline"
          disabled={offset + data.items.length >= (data.total || 0)}
          onClick={() => setOffset((n) => n + 50)}
        >
          Next
        </Button>
      </div>
      <Dialog
        open={!!edit}
        onOpenChange={(v) => {
          if (!v) setEdit(null);
        }}
      >
        <DialogContent>
          <DialogTitle>Correct listing details</DialogTitle>
          <DialogDescription>
            Corrections stay in place when the source refreshes.
          </DialogDescription>
          {edit && (
            <>
              <label htmlFor="edit-title">Title</label>
              <Input
                id="edit-title"
                value={edit.title}
                onChange={(e) => setEdit({ ...edit, title: e.target.value })}
              />
              <label htmlFor="edit-description">Description</label>
              <Textarea
                id="edit-description"
                value={edit.description}
                onChange={(e) => setEdit({ ...edit, description: e.target.value })}
              />
              <label htmlFor="edit-price">Admission in CAD (leave blank if unknown)</label>
              <Input
                id="edit-price"
                type="number"
                min="0"
                value={edit.price ?? ''}
                onChange={(e) =>
                  setEdit({ ...edit, price: e.target.value === '' ? null : Number(e.target.value) })
                }
              />
              <Button
                disabled={busy || !edit.title.trim()}
                onClick={() => action({ action: 'update', ...edit })}
              >
                {busy ? 'Saving…' : 'Save corrections'}
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </main>
  );
}
