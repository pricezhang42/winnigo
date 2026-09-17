import {requireChatGPTUser} from '@/app/chatgpt-auth';
import Admin from '@/components/admin';
export const dynamic='force-dynamic';
export default async function AdminPage(){await requireChatGPTUser('/admin');return <Admin/>;}
