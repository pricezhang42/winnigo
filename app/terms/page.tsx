import { LegalPage } from '@/components/legal-page';
export const metadata = { title: 'Terms · Winnigo' };
export default function TermsPage() {
  return (
    <LegalPage title="Terms of use">
      <h2>The service</h2>
      <p>
        Winnigo collects events, places and trails from public Winnipeg sources and links to each
        one. Details can change or be wrong: check dates, times, prices and availability with the
        organizer before you go. Winnigo is provided as is, without any guarantee that it is
        complete, accurate or available.
      </p>
      <h2>Your account</h2>
      <p>
        Use your own email address and keep your password private. You are responsible for what
        happens under your account. One person, one account.
      </p>
      <h2>Fair use</h2>
      <p>
        Do not create accounts automatically, try to reach other people&apos;s accounts or private
        content, overload the service, or copy its listings in bulk. Accounts that break these terms
        can be disabled.
      </p>
      <h2>Content</h2>
      <p>
        Listings, descriptions and photos belong to their sources and are shown with a link back to
        them. If you represent a source and want a listing corrected or removed, get in touch.
      </p>
      <h2>Changes</h2>
      <p>
        These terms may change; the date of the latest version will be shown here. You can stop
        using Winnigo and delete your account at any time.
      </p>
    </LegalPage>
  );
}
