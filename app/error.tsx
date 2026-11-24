'use client';
import Link from 'next/link';

/** Shown when a page fails to render; the details stay in the server log. */
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="account-shell status-page">
      <Link className="brand" href="/">
        winnigo.
      </Link>
      <h1>Something went wrong</h1>
      <p>Winnigo couldn&apos;t load this page. Please try again in a moment.</p>
      <div className="account-buttons">
        <button type="button" onClick={reset}>
          Try again
        </button>
        <Link href="/">Back to discoveries</Link>
      </div>
    </main>
  );
}
