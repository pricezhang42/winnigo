import {env} from 'cloudflare:workers';
import {normalizeSocial,normalizeHikingBatch} from '@/lib/social.mjs';
import {getChatGPTUser} from '@/app/chatgpt-auth';
import {initialize,refreshSources,getCollection,database} from '@/lib/store';
export const dynamic='force-dynamic';
async function authorized(request:Request){const user=await getChatGPTUser();if(!user)return false;const origin=request.headers.get('origin');return !origin||origin===new URL(request.url).origin;}
export async function GET(request:Request){if(!await authorized(request))return Response.json({error:'Sign in to manage listings.'},{status:401});try{await initialize();return Response.json(await getCollection(true));}catch{return Response.json({error:'Listing storage is temporarily unavailable.'},{status:503});}}
export async function POST(request:Request){const key=(env as unknown as {WINNIGO_COLLECTOR_KEY?:string}).WINNIGO_COLLECTOR_KEY;const collector=!!key&&request.headers.get('x-winnigo-collector-key')===key;if(!collector&&!await authorized(request))return Response.json({error:'Sign in to manage listings.'},{status:401});if(!request.headers.get('content-type')?.includes('application/json'))return Response.json({error:'JSON required'},{status:415});try{const raw=await request.text();if(raw.length>60000)return Response.json({error:'Batch too large'},{status:413});const input=JSON.parse(raw) as Record<string,unknown>;if(collector&&input.action!=='sync-hiking-manitoba')return Response.json({error:'Collector action only'},{status:403});await initialize();if(input.action==='sync-hiking-manitoba'){
 let batch;try{batch=normalizeHikingBatch(input);}catch(e){return Response.json({error:e instanceof Error?e.message:'Invalid collection batch'},{status:400});}
 const db=database();const statements=[];let added=0,updated=0;
 for(const item of batch.items){
  const existing=await db.prepare("SELECT id,payload FROM listings WHERE replace(json_extract(payload,'$.url'),'https://www.facebook.com/','https://facebook.com/')=? AND source='facebook' LIMIT 1").bind(item.url).first<{id:string;payload:string}>();
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(item.url)))).map(b=>b.toString(16).padStart(2,'0')).join('');
  const id=existing?.id||'facebook-'+hash;
  const previous=existing?JSON.parse(existing.payload):null;
  if(!previous)added++;else if(['title','description','type','category','start','end','time','venue','neighbourhood','distanceKm','difficulty','status'].some(k=>previous[k]!==item[k]))updated++;
  if(previous?.addedAt)item.addedAt=previous.addedAt;
  statements.push(db.prepare('INSERT INTO listings (id,source,payload) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').bind(id,'facebook',JSON.stringify({...item,id})));
 }
 statements.push(db.prepare("INSERT INTO sources (id,checked_at,attempted_at,count,status,error) VALUES ('facebook',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET checked_at=CASE WHEN excluded.status='ok' THEN excluded.checked_at ELSE sources.checked_at END,attempted_at=excluded.attempted_at,count=excluded.count,status=excluded.status,error=excluded.error").bind(batch.status==='ok'?batch.checkedAt:'',batch.checkedAt,batch.items.length,batch.status,batch.message||null));
 await db.batch(statements);
 return Response.json({ok:true,processed:batch.items.length,added,updated,status:batch.status});
 }else if(input.action==='refresh'){await refreshSources(true);}else if(input.action==='add-social'){
 let item;try{item=normalizeSocial(input);}catch(e){return Response.json({error:e instanceof Error?e.message:'Check the outing details.'},{status:400});}
 const db=database();const existing=await db.prepare("SELECT id FROM listings WHERE json_extract(payload,'$.url')=? AND json_extract(payload,'$.source')=? LIMIT 1").bind(item.url,item.source).first();if(existing)return Response.json({error:'This post is already in the collection. Search for it to edit its details.'},{status:409});
 const id='social-'+crypto.randomUUID();await db.prepare('INSERT INTO listings (id,source,payload) VALUES (?,?,?)').bind(id,item.source,JSON.stringify({...item,id})).run();
 }else if(input.action==='update'&&typeof input.id==='string'){
 const patch:Record<string,unknown>={};if(typeof input.title==='string'&&input.title.trim())patch.title=input.title.trim().slice(0,200);if(typeof input.description==='string')patch.description=input.description.slice(0,1200);if(input.price===null||(typeof input.price==='number'&&input.price>=0))patch.price=input.price;if(input.hidden!==undefined&&typeof input.hidden!=='boolean')return Response.json({error:'Invalid visibility'},{status:400});
 const db=database();const existing=await db.prepare('SELECT override FROM listings WHERE id=?').bind(input.id).first<{override:string|null}>();if(!existing)return Response.json({error:'Listing not found'},{status:404});const merged={...(existing.override?JSON.parse(existing.override):{}),...patch};await db.prepare('UPDATE listings SET override=?,hidden=COALESCE(?,hidden) WHERE id=?').bind(JSON.stringify(merged),input.hidden===undefined?null:Number(input.hidden),input.id).run();
 }else return Response.json({error:'Invalid action'},{status:400});return Response.json(await getCollection(true));}catch(error){console.error(error);return Response.json({error:'Changes could not be saved. Please try again.'},{status:503});}}
