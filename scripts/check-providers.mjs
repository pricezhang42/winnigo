// Checks the real sign-in providers before launch (docs/31 step 4):
//   npm run accounts:check-providers -- you@example.com
// Sends one test email through the configured delivery (SMTP, or the local outbox) and prints the
// Google redirect URL to register. Never prints secrets or provider error details.
import { loadLocalEnv } from './load-env.mjs';
import { readConfig } from '../lib/server/config.mjs';
import { sendAccountMail } from '../lib/server/account-mail.mjs';

loadLocalEnv();
const to = process.argv[2];
if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
  console.error('Usage: npm run accounts:check-providers -- you@example.com');
  process.exit(1);
}
const config = readConfig();
let failed = false;

const mode = process.env.WINNIGO_MAIL_MODE || '(not set)';
console.log(`Email: mode ${mode}${process.env.SMTP_HOST ? ', host ' + process.env.SMTP_HOST : ''}`);
try {
  await sendAccountMail({ to, url: config.origin, kind: 'test' });
  console.log(
    mode === 'file'
      ? '  Written to the local outbox (loopback testing only; real email needs WINNIGO_MAIL_MODE=smtp).'
      : '  Sent. Check that it arrives, and is not marked as spam (SPF, DKIM and DMARC).',
  );
} catch {
  failed = true;
  console.log(
    '  Not sent. Check WINNIGO_MAIL_MODE, SMTP_HOST, SMTP_PORT, SMTP_FROM and the login.',
  );
}

const google = !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
console.log(
  `Google sign-in: ${google ? 'configured' : 'not configured (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)'}`,
);
console.log(`  Authorized redirect URI to register: ${config.origin}/api/auth/callback/google`);
console.log(`  Consent screen links: ${config.origin}/privacy and ${config.origin}/terms`);
if (
  !config.origin.startsWith('https:') &&
  !/^http:\/\/(127\.0\.0\.1|localhost)/.test(config.origin)
)
  console.log('  Google requires an https origin outside loopback.');

console.log(`Sign-up: ${config.signup}; public browsing: ${config.publicBrowsing ? 'on' : 'off'}`);
process.exitCode = failed ? 1 : 0;
