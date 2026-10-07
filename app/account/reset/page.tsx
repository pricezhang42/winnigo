'use client';
import { useState } from 'react';
export default function ResetPassword() {
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <main className="account-shell">
      <a href="/login">Back to sign in</a>
      <h1>Choose a new password</h1>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const token = new URLSearchParams(window.location.search).get('token');
            const password = new FormData(e.currentTarget).get('password');
            const r = await fetch('/api/auth/reset-password', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token, newPassword: password }),
            });
            setMessage(
              r.ok
                ? 'Password changed. Sign in with your new password.'
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
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
          />
        </label>
        <button disabled={busy}>Reset password</button>
      </form>
      <p role="status">{message}</p>
    </main>
  );
}
