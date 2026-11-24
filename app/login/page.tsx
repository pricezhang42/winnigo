import AccountLogin from '@/components/account-login';
import { readConfig } from '@/lib/server/config.mjs';
export const dynamic = 'force-dynamic';
export default function LoginPage() {
  const config = readConfig();
  return (
    <AccountLogin
      google={!!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET}
      mail={process.env.WINNIGO_MAIL_MODE === 'file' || !!process.env.SMTP_HOST}
      openSignup={config.signup === 'open'}
      browsing={config.publicBrowsing}
    />
  );
}
