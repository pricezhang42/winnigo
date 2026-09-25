import {getAdmin} from '@/lib/auth';
import Admin from '@/components/admin';
export const dynamic='force-dynamic';
export default async function AdminPage(){if(!await getAdmin())return <p>Administrator sign-in required.</p>;return <Admin/>;}
