'use client';
import { useEffect, useState } from 'react';
type Session = { token: string; createdAt: string; userAgent?: string };
export default function AccountSettings({
  name,
  email,
  role,
  legacy,
}: {
  name?: string;
  email?: string;
  role: string;
  legacy: boolean;
}) {
  const [sessions, setSessions] = useState<Session[]>([]),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  async function load() {
    const r = await fetch('/api/auth/list-sessions');
    if (r.ok) setSessions(await r.json());
  }
  useEffect(() => {
    if (!legacy) void load();
  }, [legacy]);
  async function action(path: string, body: Record<string, unknown> = {}) {
    setBusy(true);
    setMessage('');
    try {
      const r = await fetch('/api/auth/' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw Error(d.message || 'The request could not be completed.');
      }
      if (path === 'sign-out') {
        window.location.assign('/login');
        return;
      }
      if (path === 'delete-user') setMessage('Check your email to confirm account deletion.');
      else await load();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="account-shell">
      <a href="/">Back to Winnigo</a>
      <h1>Your account</h1>
      <p>
        {name || 'Local owner'}
        {email ? ' · ' + email : ''}
      </p>
      <p>Role: {role}</p>
      {['owner', 'admin'].includes(role) && <a href="/admin">Manage the collection</a>}
      {legacy ? (
        <p>
          This is the local owner session. Individual sign-in is available when account mode is
          enabled.
        </p>
      ) : (
        <>
          <h2>Signed-in devices</h2>
          <button disabled={busy} onClick={() => action('revoke-other-sessions')}>
            Sign out other devices
          </button>
          <ul>
            {sessions.map((s) => (
              <li key={s.token}>
                {new Date(s.createdAt).toLocaleString()}
                <button
                  disabled={busy}
                  onClick={() => action('revoke-session', { token: s.token })}
                >
                  Revoke session
                </button>
              </li>
            ))}
          </ul>
          <button disabled={busy} onClick={() => action('sign-out')}>
            Sign out
          </button>
          {role !== 'owner' && (
            <>
              <h2>Delete account</h2>
              <p>
                This removes your login, sessions and access grants. Collection records are
                retained.
              </p>
              <button
                disabled={busy}
                onClick={() => action('delete-user', { callbackURL: '/login' })}
              >
                Email deletion confirmation
              </button>
            </>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </main>
  );
}
