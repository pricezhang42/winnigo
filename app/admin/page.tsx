import { getAdmin } from '@/lib/auth';
import Admin from '@/components/admin';
export const dynamic = 'force-dynamic';
export default async function AdminPage() {
  const principal = await getAdmin();
  if (!principal) return <p>Administrator sign-in required.</p>;
  return <Admin owner={principal.role === 'owner'} />;
}
