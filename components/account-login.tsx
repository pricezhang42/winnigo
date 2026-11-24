'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

type Mode = 'login' | 'signup' | 'reset';

// Better Auth endpoint and wording for each form mode.
const MODES: Record<Mode, { endpoint: string; heading: string; submit: string }> = {
  login: { endpoint: 'sign-in/email', heading: 'Welcome back', submit: 'Sign in' },
  signup: {
    endpoint: 'sign-up/email',
    heading: 'Accept your invitation',
    submit: 'Create account',
  },
  reset: {
    endpoint: 'request-password-reset',
    heading: 'Reset your password',
    submit: 'Send reset link',
  },
};

/**
 * Sign-in, sign-up and password-reset request. Sign-up needs an invitation unless it is open
 * (`openSignup`, docs/31). Sign-up and reset need email delivery (`mail`); Google sign-in appears
 * only when it is configured. With public browsing, visitors can go back to browsing.
 */
export default function AccountLogin({
  google,
  mail,
  openSignup = false,
  browsing = false,
}: {
  google: boolean;
  mail: boolean;
  openSignup?: boolean;
  browsing?: boolean;
}) {
  const [mode, setMode] = useState<Mode>('login');
  const [message, setMessage] = useState('');
  // After a sign-up or reset request: the address the link went to.
  const [sentTo, setSentTo] = useState<{ email: string; kind: Mode } | null>(null);
  // A sign-up refused because the address already has an account; offered for sign-in.
  const [existing, setExisting] = useState('');
  const [prefill, setPrefill] = useState('');

  // The verification link returns here with ?verified=1.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (new URLSearchParams(window.location.search).has('verified'))
        setMessage('Your email is verified. You can sign in now.');
    });
    return () => clearTimeout(timer);
  }, []);
  const [busy, setBusy] = useState(false);
  const copy =
    mode === 'signup' && openSignup
      ? { ...MODES.signup, heading: 'Create your account' }
      : MODES[mode];

  /** POSTs to a Better Auth endpoint; shows the error and returns null on failure. */
  async function request(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setMessage('');
    setExisting('');
    try {
      const response = await fetch('/api/auth/' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (result.code === 'ACCOUNT_EXISTS' && typeof body.email === 'string') {
        setExisting(body.email);
        return null;
      }
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
    else setSentTo({ email, kind: mode });
  }

  /** Switches to `target`, or back to sign-in if already there. */
  function toggleMode(target: Mode) {
    setMode(mode === target ? 'login' : target);
    setMessage('');
    setSentTo(null);
    setExisting('');
  }

  /** From a refused sign-up to sign-in, with the email filled in. */
  function signInInstead() {
    setPrefill(existing);
    toggleMode('login');
  }

  if (sentTo)
    return (
      <main className="account-shell">
        <Link className="brand" href="/">
          winnigo.
        </Link>
        <h1>Check your inbox</h1>
        <p role="status">
          {sentTo.kind === 'signup' ? (
            <>
              We sent a link to <strong>{sentTo.email}</strong> to verify your address. Open it,
              then sign in here.
            </>
          ) : (
            <>
              If an account uses <strong>{sentTo.email}</strong>, we sent it a link to choose a new
              password.
            </>
          )}
        </p>
        <p className="account-terms">Nothing after a few minutes? Check your spam folder.</p>
        <button onClick={() => toggleMode('login')}>Back to sign in</button>
      </main>
    );
  return (
    <main className="account-shell">
      <Link className="brand" href="/">
        winnigo.
      </Link>
      <h1>{copy.heading}</h1>
      <p>
        {!openSignup
          ? 'Sign in to discover your Winnipeg. New accounts require an invitation.'
          : mode === 'signup'
            ? 'Save discoveries on every device. We will email you a link to verify your address.'
            : 'Sign in to save discoveries on every device. New here? Create an account.'}
      </p>
      <form onSubmit={submit}>
        {mode === 'signup' && (
          <label>
            Name
            <input name="name" autoComplete="name" required maxLength={100} />
          </label>
        )}
        <label>
          Email
          <input
            key={mode + prefill}
            type="email"
            name="email"
            autoComplete="email"
            required
            maxLength={254}
            defaultValue={prefill}
          />
        </label>
        {mode !== 'reset' && (
          <label>
            Password
            <input
              type="password"
              name="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              required
              minLength={mode === 'signup' ? 8 : 1}
              maxLength={128}
            />
          </label>
        )}
        {mode === 'signup' && <small>At least 8 characters.</small>}
        <button disabled={busy || (!mail && mode !== 'login')} type="submit">
          {busy ? 'Please wait…' : copy.submit}
        </button>
        {message && <p role="status">{message}</p>}
        {existing && (
          <div role="status" className="account-existing">
            <p>
              An account with <strong>{existing}</strong> already exists.
              {google ? ' If you created it with Google, use “Continue with Google”.' : ''}
            </p>
            <button type="button" onClick={signInInstead}>
              Sign in instead
            </button>
          </div>
        )}
      </form>
      {google && (mode === 'login' || (mode === 'signup' && openSignup)) && (
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
          {mode === 'signup'
            ? 'Back to sign in'
            : openSignup
              ? 'Create an account'
              : 'I have an invitation'}
        </button>
        <button onClick={() => toggleMode('reset')}>
          {mode === 'reset' ? 'Back to sign in' : 'Forgot password?'}
        </button>
      </div>
      {mode === 'signup' && (
        <p className="account-terms">
          By creating an account you agree to the <Link href="/terms">terms</Link> and the{' '}
          <Link href="/privacy">privacy policy</Link>.
        </p>
      )}
      {browsing && (
        <p>
          <Link href="/">Keep browsing without an account</Link>
        </p>
      )}
      {!mail && <p>Email verification and reset are awaiting email delivery configuration.</p>}
    </main>
  );
}
