import {getPrincipal} from '@/lib/auth';
import {repository} from '@/lib/server/services';
import {getCollection} from '@/lib/store';
export const dynamic='force-dynamic';
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
 const principal=await getPrincipal();if(!principal)return Response.json({error:'Sign in required'},{status:401});
 const {id}=await params;if(id.length>300)return new Response('Not found',{status:404});
 try{const repo=repository();const item=repo.detail?await repo.detail(id,{principal}):(await getCollection()).items.find(i=>i.id===id);return item?Response.json(item,{headers:{'Cache-Control':'no-store'}}):new Response('Not found',{status:404});}catch{return new Response('Listing storage unavailable',{status:503});}
}
