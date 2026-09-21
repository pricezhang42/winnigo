import {getOwner} from '@/lib/auth';
import Admin from '@/components/admin';
export const dynamic='force-dynamic';
export default async function AdminPage(){if(!await getOwner())return <p>Owner sign-in required.</p>;return <Admin/>;}
