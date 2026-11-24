'use client';

/** Last resort when the page layout itself fails: plain markup, no app styles. */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          maxWidth: 480,
          margin: '4rem auto',
          padding: '0 1rem',
        }}
      >
        <h1>Something went wrong</h1>
        <p>Winnigo couldn&apos;t load. Please try again in a moment.</p>
        <button type="button" onClick={reset}>
          Try again
        </button>
      </body>
    </html>
  );
}
