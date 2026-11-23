import { LegalPage } from '@/components/legal-page';
export const metadata = { title: 'Privacy policy · Winnigo' };
export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy">
      <p>
        Winnigo helps people find things to do in Winnipeg. You can browse without an account; an
        account lets you keep saved discoveries on every device.
      </p>
      <h2>What we store</h2>
      <ul>
        <li>
          Your account: name, email address, whether the email is verified, and your password,
          stored only as a one-way hash. If you sign in with Google, the identifier Google gives for
          your account and the sign-in tokens, stored encrypted.
        </li>
        <li>
          Sign-in sessions: a session cookie, when it expires (after a week), and your
          browser&apos;s user agent so you can recognise your devices on the account page. Your IP
          address is not stored.
        </li>
        <li>The discoveries you save.</li>
        <li>
          A security log of account events (for example a sign-in or a password reset), with the
          account and the time but no passwords or email contents, kept for 90 days.
        </li>
      </ul>
      <p>
        Visitors without an account are not tracked. Winnigo uses no advertising or analytics
        cookies; the only cookie is the session cookie when you sign in.
      </p>
      <h2>How it is used</h2>
      <p>
        To sign you in, keep your saved discoveries, send the emails you ask for (verification and
        password reset) and keep the service secure. Your information is not sold or shared for
        advertising.
      </p>
      <h2>Who else handles it</h2>
      <ul>
        <li>The hosting and storage providers that run Winnigo.</li>
        <li>The email delivery service that sends verification and reset emails.</li>
        <li>Google, if you choose to sign in with Google.</li>
      </ul>
      <h2>Your choices</h2>
      <p>
        You can sign out of any device and delete your account from the account page. Deleting the
        account removes your profile, sessions and saved discoveries. Accounts never verified are
        removed after seven days. Copies in backups are kept for a limited time before they are
        overwritten.
      </p>
      <h2>Listings</h2>
      <p>
        Events and places come from public sources, each linked to its source, and photos belong to
        their owners. Posts from private community groups are not shown publicly.
      </p>
    </LegalPage>
  );
}
