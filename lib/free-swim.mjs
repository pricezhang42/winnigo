export const freeSwimSource = {id:'winnipeg-free-swim',name:'City of Winnipeg · Free swim',url:'https://www.winnipeg.ca/recreation-leisure/pools/swimming/free-swim'};
export const poolDirectoryUrl = 'https://www.winnipeg.ca/recreation-leisure/pools/indoor-pools';
const text = s => s.replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-$/,'');
const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function dateRange(value) {
 const m=value.match(/^([A-Za-z]+) (\d{1,2})(?:, (\d{4}))?\s*[–—-]\s*(?:([A-Za-z]+) )?(\d{1,2}), (\d{4})$/);
 if(!m)throw Error('Free swim schedule date format changed');
 const firstMonth=monthNames.indexOf(m[1]),lastMonth=monthNames.indexOf(m[4]||m[1]);
 if(firstMonth<0||lastMonth<0)throw Error('Unrecognized swim schedule month');
 const endYear=+m[6],startYear=m[3]?+m[3]:endYear-(firstMonth>lastMonth?1:0);
 const make=(year,month,day)=>`${year}-${String(month+1).padStart(2,'0')}-${day.padStart(2,'0')}`;
 const start=make(startYear,firstMonth,m[2]),end=make(endYear,lastMonth,m[5]);
 if(new Date(start).toISOString().slice(0,10)!==start||new Date(end).toISOString().slice(0,10)!==end||end<start||new Date(end)-new Date(start)>370*86400000)throw Error('Invalid swim schedule range');
 return {start,end};
}

// Expand only the published weekday/time slots within their explicit effective dates.
export function parseFreeSwim(html,checkedAt=new Date().toISOString()) {
 const blocks=html.split(/<h[23]\b[^>]*class="card-title"[^>]*>/i).slice(1);
 if(!blocks.length)throw Error('Free swim pool cards not found');
 const items=[];
 for(const block of blocks){
  const heading=block.split(/<\/h[23]>/i)[0],venue=text(heading);
  const facilityUrl=new URL(heading.match(/href="([^"]+)"/)?.[1]||'',freeSwimSource.url).href;
  const body=block.match(/field--name-field-card-body[^>]*>([\s\S]*?)<\/div>/i)?.[1];
  if(!body||!venue||!facilityUrl.includes('/pools/'))throw Error('Free swim pool structure changed');
  const paragraphs=[...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(m=>m[1]);
  const address=text(paragraphs[0]||'');
  const range=dateRange(text(paragraphs[1]||''));
  let slotCount=0;
  for(const paragraph of paragraphs.slice(2)){
   const lines=paragraph.split(/<br\s*\/?\s*>/i).map(text).filter(Boolean);
   if(!lines.length)continue;
   const weekday=days.indexOf(lines.shift());
   if(weekday<0||!lines.length)throw Error('Free swim weekday format changed');
   for(const time of lines){
    if(!/^\d{1,2}(?::\d{2})?(?:\s*[ap]\.m\.)?\s*[–—-]\s*\d{1,2}(?::\d{2})?\s*[ap]\.m\./i.test(time))throw Error('Free swim time format changed');
    const youth=/Youth swim/i.test(time);slotCount++;
    for(let day=new Date(range.start+'T12:00:00Z');day.toISOString().slice(0,10)<=range.end;day.setUTCDate(day.getUTCDate()+1)){
     if(day.getUTCDay()!==weekday)continue;
     const date=day.toISOString().slice(0,10);
     items.push({id:`winnipeg-free-swim-${slug(venue)}-${date}-${slug(time)}`,title:`${youth?'Free youth swim (ages 9–19)':'Free swim'} · ${venue}`,type:'Event',category:'Water activities',venue,address:address+', Winnipeg',neighbourhood:'Winnipeg',start:date,end:date,time:days[weekday]+' · '+time,image:'',url:freeSwimSource.url,facilityUrl,source:freeSwimSource.id,sourceName:freeSwimSource.name,checkedAt,price:0,family:!youth,indoor:facilityUrl.includes('/indoor-pools/'),description:`Scheduled free swim at ${venue}.${youth?' For ages 9–19.':''} ${/only/i.test(time)?time+'. ':''}Check the pool’s current hours and admission requirements before visiting.`,schedule:'event',status:'active',provenance:'municipal',scheduleStart:range.start,scheduleEnd:range.end});
    }
   }
  }
  if(!slotCount)throw Error('No swim sessions found for '+venue);
 }
 return items;
}

// The schedule and facility directory can disagree during a maintenance closure.
export function applyPoolClosures(items,html) {
 const cards=html.split(/<div class="card card-body">/).slice(1);
 if(!cards.length)throw Error('Pool closure directory format changed');
 const closures=new Map();
 for(const card of cards){
  if(!card.includes('Facility closed'))continue;
  const href=card.match(/<h2\b[^>]*>[\s\S]*?href="([^"]+)"/)?.[1];
  if(!href)throw Error('Closed pool link missing');
  const dates=[...card.matchAll(/<time\b[^>]*datetime="(\d{4}-\d{2}-\d{2})/g)].map(m=>m[1]);
  closures.set(new URL(href,poolDirectoryUrl).href,dates);
 }
 return items.map(item=>{
  const dates=closures.get(item.facilityUrl);
  if(!dates||(dates.length===2&&(item.start<dates[0]||item.start>dates[1])))return item;
  return {...item,status:'cancelled',description:item.description+' The City’s facility directory reports this pool closed'+(dates.length===2?` from ${dates[0]} through ${dates[1]}`:'')+'.'};
 });
}
