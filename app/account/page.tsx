import { getPrincipal } from '@/lib/auth';
import { redirect } from 'next/navigation';
import AccountSettings from '@/components/account-settings';
export const dynamic = 'force-dynamic';
export default async function AccountPage() {
  const p = await getPrincipal();
  if (!p) redirect('/login');
  return <AccountSettings {...p} />;
}
