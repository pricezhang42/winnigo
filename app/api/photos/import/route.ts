import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '@/app/chatgpt-auth';
export const dynamic='force-dynamic';
export async function POST(request:Request){
 const bindings=env as unknown as {BUCKET?:R2Bucket;WINNIGO_COLLECTOR_KEY?:string};
 const collector=!!bindings.WINNIGO_COLLECTOR_KEY&&request.headers.get('x-winnigo-collector-key')===bindings.WINNIGO_COLLECTOR_KEY;
 if(!collector&&!await getChatGPTUser())return Response.json({error:'Sign in required'},{status:401});
 if(request.headers.get('origin')&&request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'Invalid origin'},{status:403});
 if(!bindings.BUCKET)return Response.json({error:'Photo storage unavailable'},{status:503});
 let stage='read';
 try{
  const uploaded=request.headers.get('content-type')==='application/octet-stream';
  let url=request.headers.get('x-winnigo-photo-source');
  if(!uploaded){const body=await request.text();if(body.length>8000)return Response.json({error:'Request too large'},{status:413});url=JSON.parse(body).url;}
  const source=new URL(url||'');
  if(source.protocol!=='https:'||!source.hostname.endsWith('.fbcdn.net')||source.port||source.username||source.password)return Response.json({error:'Use an original Facebook photo URL'},{status:400});
  stage='fetch';
  const response=uploaded?null:await fetch(source.href,{redirect:'error',signal:AbortSignal.timeout(15000)});
  const stream=uploaded?request.body:response?.body;
  if((response&&!response.ok)||!stream)return Response.json({error:'Original photo unavailable'},{status:422});
  const reader=stream.getReader();const chunks:Uint8Array[]=[];let size=0;
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>8*1024*1024){await reader.cancel();return Response.json({error:'Photo exceeds 8 MB'},{status:413});}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const mime=bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71?'image/png':new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP'?'image/webp':null;
  if(!mime)return Response.json({error:'Unsupported photo format'},{status:415});
  const id=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
  stage='store';
  if(!await bindings.BUCKET.head('photos/'+id))await bindings.BUCKET.put('photos/'+id,bytes,{httpMetadata:{contentType:mime}});
  return Response.json({url:'/api/photos/'+id});
 }catch(error){console.error('Photo import failed',stage,error instanceof Error?error.message:'Unknown error');return Response.json({error:'Photo could not be saved; retain the original source link.'},{status:502});}
}
