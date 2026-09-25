import 'server-only';
import {communitySources} from './social.mjs';
import officialTrails from '@/lib/data/official-trails.json';
import {collectionLabel,resolveMapLocation} from '@/lib/trail-locations';
import {sources,dedupe,localDay} from './connectors.mjs';
import {repository} from './server/services';
import type {Listing} from './domain';
export async function getCollection(admin=false){
 const state=await repository().read();const today=localDay();
 const items=state.listings.map(r=>({...r.payload,...r.override,status:r.hidden?'hidden':r.payload.status})).map(i=>({...i,collection:collectionLabel(i),mapLocation:resolveMapLocation(i)})).filter(i=>admin||(!['hidden','cancelled'].includes(i.status)&&(!i.end||i.end>=today)));
 const sorted:Listing[]=(admin?items:dedupe(items)).sort((a:Listing,b:Listing)=>(a.start||today).localeCompare(b.start||today)||a.title.localeCompare(b.title));
 const groups=new Map<string,Listing[]>();for(const item of sorted){const group=groups.get(item.source)||[];group.push(item);groups.set(item.source,group);}
 const mixed:Listing[]=[];while([...groups.values()].some(g=>g.length))for(const group of groups.values()){const item=group.shift();if(item)mixed.push(item);}
 return {items:mixed,communitySources:communitySources.map(s=>{const report=state.sources.find(r=>r.id===s.id);return {...s,count:items.filter(i=>i.source===s.id).length,checkedAt:report?.checkedAt,attemptedAt:report?.attemptedAt,status:report?.status||'pending',error:admin?report?.error:undefined};}),sources:state.sources.filter(r=>r.id!=='facebook').map(r=>({...[...sources,officialTrails.source].find(s=>s.id===r.id),count:r.count,status:r.status,checkedAt:r.checkedAt,attemptedAt:r.attemptedAt,error:admin?r.error:undefined})),notice:'Development snapshot. Automatic source collection is not running in this environment.'};
}
