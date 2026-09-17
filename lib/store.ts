import {communitySources} from './social.mjs';
import {env} from 'cloudflare:workers';
import socialSeeds from '@/lib/data/social-listings.json';
import seeds from '@/lib/data/listings.json';
import sourceSeeds from '@/lib/data/sources.json';
import {sources,parseSource,dedupe,localDay} from './connectors.mjs';
export function database():D1Database{if(!env.DB)throw new Error('Listing storage unavailable');return env.DB;}
export async function initialize(){const db=database();await db.batch(socialSeeds.map(item=>db.prepare('INSERT OR IGNORE INTO listings (id,source,payload) VALUES (?,?,?)').bind(item.id,item.source,JSON.stringify(item))));const ready=await db.prepare("SELECT COUNT(*) AS total FROM sources WHERE id != 'facebook'").first<{total:number}>();if(ready?.total===sources.length)return;await db.batch([...seeds.map(item=>db.prepare('INSERT OR IGNORE INTO listings (id,source,payload) VALUES (?,?,?)').bind(item.id,item.source,JSON.stringify(item))),...sourceSeeds.map(s=>db.prepare('INSERT OR IGNORE INTO sources (id,checked_at,attempted_at,count,status) VALUES (?,?,?,?,?)').bind(s.id,s.checkedAt,s.checkedAt,s.count,s.status))]);}
export async function refreshSources(force=false){
 const db=database();const now=new Date().toISOString();const threshold=new Date(Date.now()-(force?60000:6*3600000)).toISOString();
 return await Promise.all(sources.map(async source=>{
 const lock=await db.prepare('UPDATE sources SET attempted_at=? WHERE id=? AND attempted_at<?').bind(now,source.id,threshold).run();if(!lock.meta.changes)return;
 try{
 const response=await fetch(source.url,{headers:{'User-Agent':'Winnigo/1.0 (Winnipeg discovery; source-attributed listings)'},signal:AbortSignal.timeout(12000)});if(!response.ok)throw Error('Source returned HTTP '+response.status);
 const html=await response.text();if(html.length>2_000_000)throw Error('Unexpected source size');const items=parseSource(source.id,html,now);if(!items.length)throw Error('No listings found; calendar may have changed');
 await db.batch([...items.map((item:typeof seeds[number])=>db.prepare('INSERT INTO listings (id,source,payload) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').bind(item.id,item.source,JSON.stringify(item))),db.prepare('UPDATE sources SET checked_at=?,count=?,status=?,error=NULL WHERE id=?').bind(now,items.length,'ok',source.id)]);
 }catch(error){console.error('Winnigo import',source.id,error);await db.prepare('UPDATE sources SET status=?,error=? WHERE id=?').bind('error',error instanceof Error?error.message:'Import unavailable',source.id).run();}
 }));
}
export async function getCollection(admin=false){const db=database();const [rows,reports]=await Promise.all([db.prepare('SELECT * FROM listings').all<{id:string;payload:string;hidden:number;override:string|null}>(),db.prepare('SELECT * FROM sources').all<{id:string;checked_at:string;attempted_at:string;count:number;status:string;error:string|null}>()]);const today=localDay();const items=rows.results.map(r=>({...JSON.parse(r.payload),...(r.override?JSON.parse(r.override):{}),status:r.hidden?'hidden':JSON.parse(r.payload).status})).filter(i=>admin||(!['hidden','cancelled'].includes(i.status)&&(!i.end||i.end>=today)));
 const sorted=(admin?items:dedupe(items)).sort((a,b)=>(a.start||today).localeCompare(b.start||today)||a.title.localeCompare(b.title));
 // Rotate through source groups so discovery shows a useful mix of calendars.
 const groups=new Map<string,typeof sorted>();for(const i of sorted){const group=groups.get(i.source)||[];group.push(i);groups.set(i.source,group);}const mixed=[];while([...groups.values()].some(g=>g.length)){for(const g of groups.values())if(g.length)mixed.push(g.shift());}
 return {items:mixed,communitySources:communitySources.map(s=>{const report=reports.results.find(r=>r.id===s.id);return {...s,count:items.filter(i=>i.source===s.id).length,checkedAt:report?.checked_at,attemptedAt:report?.attempted_at,status:report?.status||'pending',error:report?.error};}),sources:reports.results.filter(r=>r.id!=='facebook').map(r=>({...sources.find(s=>s.id===r.id),count:r.count,status:r.status,checkedAt:r.checked_at,attemptedAt:r.attempted_at,error:admin?r.error:undefined})),notice:reports.results.some(s=>s.id!=='facebook'&&s.status==='error')?'Some sources could not be refreshed. Their last collected listings are still available.':''};
}
