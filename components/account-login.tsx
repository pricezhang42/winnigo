'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  PASSWORD_HINT,
  PASSWORD_MAX,
  PASSWORD_MIN,
  passwordProblem,
} from '@/lib/password-policy.mjs';

/** Google's "G" mark, for the sign-in button. */
function GoogleMark() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

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
  // Sign-up's new password and its confirmation; the mismatch shows once the person leaves the
  // confirmation field, then updates as they type.
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [confirmLeft, setConfirmLeft] = useState(false);
  const mismatch = mode === 'signup' && confirmLeft && confirm !== password;

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
    if (mode === 'signup') {
      setConfirmLeft(true);
      if (confirm !== password) return;
      const problem = passwordProblem(password);
      if (problem) return setMessage(problem);
    }
    const body =
      mode === 'reset'
        ? { email, redirectTo: '/account/reset' }
        : mode === 'signup'
          ? { email, password, name: form.get('name'), callbackURL: '/login?verified=1' }
          : { email, password };
    const result = await request(copy.endpoint, body);
    if (!result) return;
    // A full load on purpose: router.replace('/') followed by router.refresh() re-rendered
    // /login and cancelled the navigation, leaving a signed-in person on the sign-in page.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    if (mode === 'login') window.location.assign('/');
    else setSentTo({ email, kind: mode });
  }

  /** Switches to `target`, or back to sign-in if already there. */
  function toggleMode(target: Mode) {
    setMode(mode === target ? 'login' : target);
    setMessage('');
    setSentTo(null);
    setExisting('');
    setPassword('');
    setConfirm('');
    setConfirmLeft(false);
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
        {mode === 'login' && (
          <label>
            Password
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              maxLength={PASSWORD_MAX}
            />
          </label>
        )}
        {mode === 'signup' && (
          <>
            <label>
              Password
              <input
                type="password"
                name="password"
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
              Confirm password
              <input
                type="password"
                name="confirm"
                autoComplete="new-password"
                required
                maxLength={PASSWORD_MAX}
                value={confirm}
                aria-invalid={mismatch}
                aria-describedby={mismatch ? 'password-mismatch' : undefined}
                onChange={(event) => setConfirm(event.target.value)}
                onBlur={() => setConfirmLeft(confirm !== '')}
              />
              {mismatch && (
                <small id="password-mismatch" className="field-error">
                  Passwords don&apos;t match
                </small>
              )}
            </label>
          </>
        )}
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
        <div className="google-row">
          <button
            className="google-button"
            disabled={busy}
            onClick={async () => {
              const result = await request('sign-in/social', {
                provider: 'google',
                callbackURL: '/',
              });
              if (result?.url) window.location.assign(result.url);
            }}
          >
            <GoogleMark />
            Continue with Google
          </button>
        </div>
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
