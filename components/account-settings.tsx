'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  PASSWORD_HINT,
  PASSWORD_MAX,
  PASSWORD_MIN,
  passwordProblem,
} from '@/lib/password-policy.mjs';
import { localParts } from '@/lib/time-zone.mjs';

type Device = { id: string; label: string; lastActive: string; current: boolean };

const METHOD_NAMES: Record<string, string> = {
  credential: 'email and password',
  google: 'Google',
};

/** "today", "yesterday" or "Nov 21", in Winnipeg. */
function dayLabel(instant: string) {
  const day = localParts(instant).date;
  const today = localParts(new Date()).date;
  const yesterday = localParts(new Date(Date.parse(today) - 12 * 3600e3)).date;
  if (day === today) return 'today';
  if (day === yesterday) return 'yesterday';
  const [, month, date] = day.split('-').map(Number);
  const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
  return `${months[month - 1]} ${date}`;
}

/** POSTs to a Better Auth endpoint; throws the reply's message (or code) on failure. */
async function authRequest(path: string, body: Record<string, unknown> = {}) {
  const response = await fetch('/api/auth/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(Error(result.message || 'That did not work. Please try again.'), {
      code: result.code as string | undefined,
    });
  return result;
}

/**
 * The signed-in person's account (docs/31): profile, saved discoveries, how they sign in,
 * signed-in devices, sign-out and deletion. Admins and the owner also get links to the admin
 * pages. The local and Basic owner has no account, so only the admin links apply.
 */
export default function AccountSettings({
  role,
  legacy,
  name = '',
  email = '',
  methods = [],
  saved = 0,
  devices = [],
}: {
  role: string;
  legacy: boolean;
  name?: string;
  email?: string;
  methods?: string[];
  saved?: number;
  devices?: Device[];
}) {
  const staff = role === 'owner' || role === 'admin';
  return (
    <main className="account-shell account-page">
      <header className="account-top">
        <Link className="brand" href="/">
          winnigo.
        </Link>
        <Link href="/">Back to discoveries</Link>
      </header>
      <h1>
        Your account
        {staff && <span className="account-badge">{role === 'owner' ? 'Owner' : 'Admin'}</span>}
      </h1>
      {legacy ? (
        <p>
          You are signed in as the local owner. Accounts, saved items across devices and device
          management are available when account sign-in is enabled.
        </p>
      ) : (
        <>
          <Profile name={name} email={email} />
          <section className="account-section" aria-labelledby="saved-heading">
            <h2 id="saved-heading">Saved</h2>
            <div className="account-row">
              <p>
                {saved === 0
                  ? 'Nothing saved yet. Use the bookmark on any discovery to keep it here.'
                  : `${saved} saved ${saved === 1 ? 'discovery' : 'discoveries'}, on every device you sign in to.`}
              </p>
              {saved > 0 && <Link href="/?tab=saved">View saved</Link>}
            </div>
          </section>
          <Security methods={methods} />
          <Devices devices={devices} />
        </>
      )}
      {staff && (
        <section className="account-section" aria-labelledby="admin-heading">
          <h2 id="admin-heading">Administration</h2>
          <ul className="account-list">
            <li>
              <Link href="/admin">Manage the collection</Link>
            </li>
            {role === 'owner' && (
              <li>
                <Link href="/admin#users">Manage users</Link>
              </li>
            )}
          </ul>
        </section>
      )}
      {!legacy && <Leave owner={role === 'owner'} />}
      <footer className="account-footer">
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
      </footer>
    </main>
  );
}

/** Name (editable) and email. */
function Profile({ name, email }: { name: string; email: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState(name);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const next = draft.trim();
    if (!next) return setMessage('Enter your name.');
    setBusy(true);
    setMessage('');
    try {
      await authRequest('update-user', { name: next });
      setCurrent(next);
      setEditing(false);
      setMessage('Name updated.');
      router.refresh();
    } catch (failure) {
      setMessage((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="account-section" aria-labelledby="profile-heading">
      <h2 id="profile-heading">Profile</h2>
      {editing ? (
        <form className="account-form" onSubmit={save}>
          <label>
            Name
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              autoComplete="name"
              required
              maxLength={100}
              autoFocus
            />
          </label>
          <div className="account-buttons">
            <button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setDraft(current);
                setEditing(false);
                setMessage('');
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <dl className="account-fields">
          <div>
            <dt>Name</dt>
            <dd>
              {current || 'Not set'}
              <button
                type="button"
                className="link"
                onClick={() => {
                  setEditing(true);
                  setMessage('');
                }}
              >
                Edit
              </button>
            </dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{email}</dd>
          </div>
        </dl>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

/** How the person signs in, and changing the password when they have one. */
function Security({ methods }: { methods: string[] }) {
  const hasPassword = methods.includes('credential');
  const names = methods.map((method) => METHOD_NAMES[method] || method);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [confirmLeft, setConfirmLeft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const mismatch = confirmLeft && confirm !== password;

  function close() {
    setOpen(false);
    setCurrent('');
    setPassword('');
    setConfirm('');
    setConfirmLeft(false);
  }

  async function change(event: React.FormEvent) {
    event.preventDefault();
    setConfirmLeft(true);
    if (confirm !== password) return;
    const problem = passwordProblem(password);
    if (problem) return setMessage(problem);
    setBusy(true);
    setMessage('');
    try {
      await authRequest('change-password', {
        currentPassword: current,
        newPassword: password,
        revokeOtherSessions: true,
      });
      close();
      setMessage('Password changed. Your other devices were signed out.');
    } catch (failure) {
      const { code, message } = failure as Error & { code?: string };
      setMessage(code === 'INVALID_PASSWORD' ? 'Your current password is incorrect.' : message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="account-section" aria-labelledby="security-heading">
      <h2 id="security-heading">Sign-in and security</h2>
      <p>
        You sign in with{' '}
        {names.length
          ? names.map((n, i) => (
              <span key={n}>
                {i > 0 && (i === names.length - 1 ? ' or ' : ', ')}
                <strong>{n}</strong>
              </span>
            ))
          : 'no sign-in method'}
        .
      </p>
      {!hasPassword && (
        <p className="account-note">
          Your password is managed by your Google account, so there is nothing to change here.
        </p>
      )}
      {hasPassword && !open && (
        <button type="button" className="secondary" onClick={() => setOpen(true)}>
          Change password
        </button>
      )}
      {hasPassword && open && (
        <form className="account-form" onSubmit={change}>
          <label>
            Current password
            <input
              type="password"
              autoComplete="current-password"
              required
              maxLength={PASSWORD_MAX}
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              autoFocus
            />
          </label>
          <label>
            New password
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN}
              maxLength={PASSWORD_MAX}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <small>{PASSWORD_HINT}</small>
          </label>
          <label>
            Confirm new password
            <input
              type="password"
              autoComplete="new-password"
              required
              maxLength={PASSWORD_MAX}
              value={confirm}
              aria-invalid={mismatch}
              aria-describedby={mismatch ? 'new-password-mismatch' : undefined}
              onChange={(event) => setConfirm(event.target.value)}
              onBlur={() => setConfirmLeft(confirm !== '')}
            />
            {mismatch && (
              <small id="new-password-mismatch" className="field-error">
                Passwords don&apos;t match
              </small>
            )}
          </label>
          <small>Changing your password signs you out on your other devices.</small>
          <div className="account-buttons">
            <button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Change password'}
            </button>
            <button type="button" className="secondary" onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

/** Signed-in devices, this one first, and signing out of the others. */
function Devices({ devices }: { devices: Device[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const others = devices.filter((device) => !device.current).length;

  async function signOutOthers() {
    setBusy(true);
    setMessage('');
    try {
      await authRequest('revoke-other-sessions');
      setMessage('Signed out of your other devices.');
      router.refresh();
    } catch (failure) {
      setMessage((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="account-section" aria-labelledby="devices-heading">
      <h2 id="devices-heading">Devices</h2>
      <ul className="account-devices">
        {devices.map((device) => (
          <li key={device.id}>
            <span>{device.label}</span>
            {device.current ? (
              <span className="account-tag">This device</span>
            ) : (
              <small>Last active {dayLabel(device.lastActive)}</small>
            )}
          </li>
        ))}
      </ul>
      {others > 0 && (
        <button type="button" className="secondary" disabled={busy} onClick={signOutOthers}>
          Sign out of other devices
        </button>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

/** Sign out, and account deletion (by emailed confirmation); the owner cannot delete here. */
function Leave({ owner }: { owner: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function run(path: string, body?: Record<string, unknown>) {
    setBusy(true);
    setMessage('');
    try {
      await authRequest(path, body);
      if (path === 'sign-out') {
        router.replace('/');
        router.refresh();
        return;
      }
      setMessage('Check your email for a link to confirm deleting your account.');
    } catch (failure) {
      setMessage((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="account-section">
        <button type="button" className="secondary" disabled={busy} onClick={() => run('sign-out')}>
          Sign out
        </button>
      </section>
      <section className="account-section account-danger" aria-labelledby="delete-heading">
        <h2 id="delete-heading">Delete account</h2>
        {owner ? (
          <p className="account-note">
            The owner account can&apos;t be deleted here. Transfer ownership first with the operator
            commands.
          </p>
        ) : (
          <>
            <p>Deletes your account and saved items. We&apos;ll email you a link to confirm.</p>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => run('delete-user', { callbackURL: '/login' })}
            >
              Delete my account
            </button>
          </>
        )}
        {message && <p role="status">{message}</p>}
      </section>
    </>
  );
}
