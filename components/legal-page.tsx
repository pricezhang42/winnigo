import Link from 'next/link';

/**
 * Shared frame for the privacy policy and terms (docs/31). The text is a draft for the owner to
 * approve before launch; `WINNIGO_CONTACT_EMAIL` supplies the contact address.
 */
export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  const contact = process.env.WINNIGO_CONTACT_EMAIL;
  return (
    <main className="account-shell legal-page">
      <Link className="brand" href="/">
        winnigo.
      </Link>
      <p className="notice">Draft, to be reviewed before Winnigo opens to the public.</p>
      <h1>{title}</h1>
      {children}
      <h2>Contact</h2>
      <p>
        {contact ? (
          <>
            Questions or requests: <a href={'mailto:' + contact}>{contact}</a>.
          </>
        ) : (
          'Contact details will be added before launch.'
        )}
      </p>
      <p>
        <Link href="/privacy">Privacy policy</Link> · <Link href="/terms">Terms</Link> ·{' '}
        <Link href="/">Back to Winnigo</Link>
      </p>
    </main>
  );
}
