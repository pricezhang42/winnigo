'use client';
import { useState } from 'react';
import {
  PASSWORD_HINT,
  PASSWORD_MAX,
  PASSWORD_MIN,
  passwordProblem,
} from '@/lib/password-policy.mjs';

/** Choose a new password from a reset link: the same rule and confirmation as sign-up. */
export default function ResetPassword() {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [confirmLeft, setConfirmLeft] = useState(false);
  const mismatch = confirmLeft && confirm !== password;
  return (
    <main className="account-shell">
      <a href="/login">Back to sign in</a>
      <h1>Choose a new password</h1>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setConfirmLeft(true);
          if (confirm !== password) return;
          const problem = passwordProblem(password);
          if (problem) return setMessage(problem);
          setBusy(true);
          try {
            const token = new URLSearchParams(window.location.search).get('token');
            const r = await fetch('/api/auth/reset-password', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token, newPassword: password }),
            });
            const result = await r.json().catch(() => ({}));
            setMessage(
              r.ok
                ? 'Password changed. Sign in with your new password.'
                : result.code === 'WEAK_PASSWORD'
                  ? result.message
                  : 'The reset link is invalid or expired. Request a new one.',
            );
          } catch {
            setMessage('Please try again.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          New password
          <input
            type="password"
            name="password"
            required
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <small>{PASSWORD_HINT}</small>
        </label>
        <label>
          Confirm password
          <input
            type="password"
            name="confirm"
            required
            maxLength={PASSWORD_MAX}
            autoComplete="new-password"
            value={confirm}
            aria-invalid={mismatch}
            aria-describedby={mismatch ? 'password-mismatch' : undefined}
            onChange={(e) => setConfirm(e.target.value)}
            onBlur={() => setConfirmLeft(confirm !== '')}
          />
          {mismatch && (
            <small id="password-mismatch" className="field-error">
              Passwords don&apos;t match
            </small>
          )}
        </label>
        <button disabled={busy}>Reset password</button>
      </form>
      <p role="status">{message}</p>
    </main>
  );
}
