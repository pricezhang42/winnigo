import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getPrincipal } from '@/lib/auth';
import { accounts } from '@/lib/server/accounts.mjs';
import { accountOverview } from '@/lib/server/account-overview.mjs';
import { database } from '@/lib/server/postgres.mjs';
import AccountSettings from '@/components/account-settings';
export const dynamic = 'force-dynamic';

/** The signed-in person's account page (docs/31); the local and Basic owner has no account. */
export default async function AccountPage() {
  const principal = await getPrincipal();
  if (!principal) redirect('/login');
  if (principal.legacy) return <AccountSettings role={principal.role} legacy />;
  const session = await accounts().api.getSession({ headers: await headers() });
  const overview = await accountOverview(database(), principal.userId, session?.session.id);
  return (
    <AccountSettings
      role={principal.role}
      name={principal.name}
      email={principal.email}
      legacy={false}
      {...overview}
    />
  );
}
