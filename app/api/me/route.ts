import {getPrincipal} from '@/lib/auth';
export const dynamic='force-dynamic';
export async function GET(){const p=await getPrincipal();return p?Response.json(p,{headers:{'Cache-Control':'no-store'}}):Response.json({error:'Sign in required'},{status:401});}
