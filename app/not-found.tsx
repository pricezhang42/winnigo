import Link from 'next/link';

export const metadata = { title: 'Not found · Winnigo' };

/** Shown for an unknown address, or a listing that is no longer available. */
export default function NotFound() {
  return (
    <main className="account-shell status-page">
      <Link className="brand" href="/">
        winnigo.
      </Link>
      <h1>Page not found</h1>
      <p>This page doesn&apos;t exist, or what it showed is no longer listed.</p>
      <p>
        <Link href="/">Back to discoveries</Link>
      </p>
    </main>
  );
}
