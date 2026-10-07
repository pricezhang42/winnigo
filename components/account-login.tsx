'use client';
import { useState } from 'react';
export default function AccountLogin({ google, mail }: { google: boolean; mail: boolean }) {
  const [mode, setMode] = useState('login'),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  async function request(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setMessage('');
    try {
      const r = await fetch('/api/auth/' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw Error(d.message || 'The request could not be completed. Please try again.');
      return d;
    } catch (e) {
      setMessage((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget),
      email = String(f.get('email')),
      password = String(f.get('password') || '');
    const d = await request(
      mode === 'signup'
        ? 'sign-up/email'
        : mode === 'reset'
          ? 'request-password-reset'
          : 'sign-in/email',
      mode === 'reset'
        ? { email, redirectTo: '/account/reset' }
        : mode === 'signup'
          ? { email, password, name: f.get('name'), callbackURL: '/login?verified=1' }
          : { email, password },
    );
    if (d) {
      if (mode === 'login') window.location.assign('/');
      else
        setMessage(
          mode === 'signup'
            ? 'Check your email to verify your account before signing in.'
            : 'If that account exists, a password reset link has been sent.',
        );
    }
  }
  return (
    <main className="account-shell">
      <a className="brand" href="/">
        winnigo.
      </a>
      <h1>
        {mode === 'signup'
          ? 'Accept your invitation'
          : mode === 'reset'
            ? 'Reset your password'
            : 'Welcome back'}
      </h1>
      <p>Sign in to discover your Winnipeg. New accounts require an invitation.</p>
      <form onSubmit={submit}>
        {mode === 'signup' && (
          <label>
            Name
            <input name="name" autoComplete="name" required maxLength={100} />
          </label>
        )}
        <label>
          Email
          <input type="email" name="email" autoComplete="email" required maxLength={254} />
        </label>
        {mode !== 'reset' && (
          <label>
            Password
            <input
              type="password"
              name="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              required
              minLength={mode === 'signup' ? 12 : 1}
              maxLength={128}
            />
          </label>
        )}
        <button disabled={busy || (!mail && mode !== 'login')} type="submit">
          {busy
            ? 'Please wait…'
            : mode === 'signup'
              ? 'Create account'
              : mode === 'reset'
                ? 'Send reset link'
                : 'Sign in'}
        </button>
      </form>
      {google && mode === 'login' && (
        <button
          disabled={busy}
          onClick={async () => {
            const d = await request('sign-in/social', { provider: 'google', callbackURL: '/' });
            if (d?.url) window.location.assign(d.url);
          }}
        >
          Continue with Google
        </button>
      )}
      <div className="account-links">
        <button
          onClick={() => {
            setMode(mode === 'signup' ? 'login' : 'signup');
            setMessage('');
          }}
        >
          {mode === 'signup' ? 'Back to sign in' : 'I have an invitation'}
        </button>
        <button
          onClick={() => {
            setMode(mode === 'reset' ? 'login' : 'reset');
            setMessage('');
          }}
        >
          {mode === 'reset' ? 'Back to sign in' : 'Forgot password?'}
        </button>
      </div>
      {!mail && <p>Email verification and reset are awaiting email delivery configuration.</p>}
      {message && <p role="status">{message}</p>}
    </main>
  );
}
