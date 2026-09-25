import 'server-only';
import {repository} from './services';
import {getCollection} from '../store';
import {sources,localDay} from '../connectors.mjs';
import official from '../data/official-trails.json';
import {communitySources} from '../social.mjs';
export async function searchCollection(query:Record<string,unknown>,admin=false,principal?:{userId:string;role:string}){
 const repo=repository();
 if(repo.search){const page=await repo.search({...query,admin,principal});return {...page,sources:page.reports.filter(s=>s.id!=='facebook').map(s=>({...sources.find(x=>x.id===s.id),...(s.id==='trails-manitoba'?official.source:{}),...s,error:admin?s.error:undefined})),communitySources:communitySources.filter(s=>principal?.role==='owner'||page.reports.some(r=>r.id===s.id)).map(s=>({...s,...page.reports.find(r=>r.id===s.id)})),reports:undefined,notice:'Automatic source collection is not running yet. Check source dates before visiting.'};}
 if(principal?.role!=='owner')throw Error('Fixture access requires owner');
 const data=await getCollection(admin);let items=data.items;
 // Fixture compatibility is intentionally in-memory; PostgreSQL queries stay bounded.
 const q=query;const today=localDay();
 items=items.filter(i=>(!q.query||`${i.title} ${i.venue} ${i.category} ${admin?i.sourceName:''}`.toLowerCase().includes(String(q.query).toLowerCase()))&&(!q.collection||q.collection==='All discoveries'||i.collection===q.collection)&&(!q.category||q.category==='All'||i.category===q.category||i.activityCategories?.includes(String(q.category))||(q.category==='Outdoors'&&['Hiking','Cycling'].includes(i.category)))&&(!q.area||q.area==='All neighbourhoods'||i.neighbourhood===q.area)&&(!['Events','Places','Activities'].includes(String(q.tab))||i.type===({Events:'Event',Places:'Place',Activities:'Activity'} as Record<string,string>)[String(q.tab)])&&(q.tab!=='Trail map'||i.source==='trails-manitoba'||['Hiking','Cycling'].includes(i.category))&&(q.tab!=='Saved'||(q.ids as string[]||[]).includes(i.id))&&(q.quick!=='Free'||i.price===0)&&(q.quick!=='Family-friendly'||i.family)&&(q.quick!=='Indoors'||i.indoor)&&(q.quick!=='Today'||(i.schedule==='event'&&!!i.start&&i.start<=today&&(i.end||i.start)>=today)));
 if(q.quick==='This weekend'){const start=new Date(today+'T12:00:00Z'),day=start.getUTCDay();start.setUTCDate(start.getUTCDate()+(day===0?-2:day===6?-1:5-day));const end=new Date(start);end.setUTCDate(end.getUTCDate()+2);items=items.filter(i=>i.schedule==='event'&&!!i.start&&i.start<=end.toISOString().slice(0,10)&&(i.end||i.start)>=start.toISOString().slice(0,10));}
 if(q.season&&q.season!=='Any')items=items.filter(i=>i.seasons?.includes(String(q.season)));
 if(q.difficulty&&q.difficulty!=='Any')items=items.filter(i=>(i.difficulty||'Unknown')===q.difficulty);
 if(q.distance&&q.distance!=='Any')items=items.filter(i=>i.distanceKm!=null&&(q.distance==='short'?i.distanceKm<=5:q.distance==='medium'?i.distanceKm>5&&i.distanceKm<=15:i.distanceKm>15));
 const offset=Number(q.offset||0),limit=Number(q.limit||24);return {...data,items:items.slice(offset,offset+limit),total:items.length,nextOffset:offset+limit<items.length?offset+limit:null,areas:[...new Set(data.items.map(i=>i.neighbourhood))].sort()};
}
