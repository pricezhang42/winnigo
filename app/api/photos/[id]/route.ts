import {env} from 'cloudflare:workers';
export const dynamic='force-dynamic';
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
 const {id}=await params;if(!/^[a-f0-9]{64}$/.test(id))return new Response('Not found',{status:404});
 try{const bucket=(env as unknown as {BUCKET?:R2Bucket}).BUCKET;if(!bucket)return new Response('Photo storage unavailable',{status:503});const photo=await bucket.get('photos/'+id);if(!photo)return new Response('Photo unavailable',{status:404});
 return new Response(photo.body,{headers:{'Content-Type':photo.httpMetadata?.contentType||'image/jpeg','Cache-Control':'private, max-age=86400','X-Content-Type-Options':'nosniff',ETag:photo.httpEtag}});
 }catch{return new Response('Photo temporarily unavailable',{status:503});}
}
