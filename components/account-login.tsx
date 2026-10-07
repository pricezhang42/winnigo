'use client';
import { useState } from 'react';

type Mode = 'login' | 'signup' | 'reset';

// Better Auth endpoint and wording for each form mode.
const MODES: Record<Mode, { endpoint: string; heading: string; submit: string; done?: string }> = {
  login: { endpoint: 'sign-in/email', heading: 'Welcome back', submit: 'Sign in' },
  signup: {
    endpoint: 'sign-up/email',
    heading: 'Accept your invitation',
    submit: 'Create account',
    done: 'Check your email to verify your account before signing in.',
  },
  reset: {
    endpoint: 'request-password-reset',
    heading: 'Reset your password',
    submit: 'Send reset link',
    done: 'If that account exists, a password reset link has been sent.',
  },
};

/**
 * Sign-in, invited sign-up and password-reset request. Sign-up and reset need email delivery
 * (`mail`); Google sign-in appears only when it is configured.
 */
export default function AccountLogin({ google, mail }: { google: boolean; mail: boolean }) {
  const [mode, setMode] = useState<Mode>('login');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const copy = MODES[mode];

  /** POSTs to a Better Auth endpoint; shows the error and returns null on failure. */
  async function request(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/auth/' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok)
        throw Error(result.message || 'The request could not be completed. Please try again.');
      return result;
    } catch (failure) {
      setMessage((failure as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email'));
    const password = String(form.get('password') || '');
    const body =
      mode === 'reset'
        ? { email, redirectTo: '/account/reset' }
        : mode === 'signup'
          ? { email, password, name: form.get('name'), callbackURL: '/login?verified=1' }
          : { email, password };
    const result = await request(copy.endpoint, body);
    if (!result) return;
    if (mode === 'login') window.location.assign('/');
    else setMessage(copy.done!);
  }

  /** Switches to `target`, or back to sign-in if already there. */
  function toggleMode(target: Mode) {
    setMode(mode === target ? 'login' : target);
    setMessage('');
  }
  return (
    <main className="account-shell">
      <a className="brand" href="/">
        winnigo.
      </a>
      <h1>{copy.heading}</h1>
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
          {busy ? 'Please wait…' : copy.submit}
        </button>
      </form>
      {google && mode === 'login' && (
        <button
          disabled={busy}
          onClick={async () => {
            const result = await request('sign-in/social', {
              provider: 'google',
              callbackURL: '/',
            });
            if (result?.url) window.location.assign(result.url);
          }}
        >
          Continue with Google
        </button>
      )}
      <div className="account-links">
        <button onClick={() => toggleMode('signup')}>
          {mode === 'signup' ? 'Back to sign in' : 'I have an invitation'}
        </button>
        <button onClick={() => toggleMode('reset')}>
          {mode === 'reset' ? 'Back to sign in' : 'Forgot password?'}
        </button>
      </div>
      {!mail && <p>Email verification and reset are awaiting email delivery configuration.</p>}
      {message && <p role="status">{message}</p>}
    </main>
  );
}
