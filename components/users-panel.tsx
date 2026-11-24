'use client';
import { useCallback, useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { dateTimeLabel } from '@/lib/time-zone.mjs';

type User = {
  id: string;
  name: string;
  email: string;
  verified: boolean;
  createdAt: string;
  role: 'owner' | 'admin' | 'user';
  enabled: boolean;
  methods: string[];
  lastSignIn: string | null;
};

const METHOD_LABELS: Record<string, string> = { credential: 'Email', google: 'Google' };

/**
 * The owner's Users panel (docs/31): accounts with role, status and sign-in methods. The owner
 * can make an account an admin or a user, and disable or re-enable it; the owner's own account
 * changes only through the operator commands.
 */
export function UsersPanel() {
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/users?q=' + encodeURIComponent(query));
      const result = await response.json();
      if (!response.ok) throw Error(result.error || 'Accounts are unavailable.');
      setUsers(result.users);
      setTotal(result.total);
      setError('');
    } catch (failure) {
      setError((failure as Error).message);
    }
  }, [query]);

  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load]);

  async function update(userId: string, changes: { role?: string; enabled?: boolean }) {
    setBusy(true);
    try {
      const response = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', userId, ...changes }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(result.error || 'The change could not be saved.');
      await load();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="users" className="event-review users-panel" aria-label="Users">
      <div className="event-review-head">
        <div>
          <h2>Users</h2>
          <p>
            {total} account{total === 1 ? '' : 's'}. Admins can manage the collection; disabling an
            account signs it out everywhere. Your own account changes only through the operator
            commands.
          </p>
        </div>
      </div>
      <div className="search-row">
        <Search size={18} />
        <Input
          aria-label="Search accounts"
          placeholder="Search by name or email…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <ul className="event-changes">
        {users.map((user) => (
          <li key={user.id} className={user.enabled ? '' : 'checked'}>
            <div className="event-change-head">
              <span className="run-status">{user.role}</span>
              <strong>{user.name || user.email}</strong>
              <small>
                {user.email}
                {user.verified ? '' : ' · not verified'}
                {user.enabled ? '' : ' · disabled'}
                {' · '}
                {user.methods.map((m) => METHOD_LABELS[m] || m).join(', ') || 'no sign-in method'}
                {' · joined '}
                {dateTimeLabel(user.createdAt, { year: true })}
                {user.lastSignIn
                  ? ' · last sign-in ' + dateTimeLabel(user.lastSignIn, { year: true })
                  : ''}
              </small>
            </div>
            {user.role !== 'owner' && (
              <div className="event-change-actions">
                <Button
                  variant="outline"
                  disabled={busy || !user.verified}
                  onClick={() =>
                    update(user.id, { role: user.role === 'admin' ? 'user' : 'admin' })
                  }
                >
                  {user.role === 'admin' ? 'Make user' : 'Make admin'}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => update(user.id, { enabled: !user.enabled })}
                >
                  {user.enabled ? 'Disable' : 'Enable'}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
