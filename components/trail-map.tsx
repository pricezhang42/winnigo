'use client';
import 'leaflet/dist/leaflet.css';
import {useEffect,useMemo,useRef,useState} from 'react';
import type * as Leaflet from 'leaflet';
import {ExternalLink,Maximize} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Tabs,TabsList,TabsTrigger,TabsContent} from '@/components/ui/tabs';
import type {Listing} from '@/components/winnigo';
import data from '@/lib/data/trail-map.json';
import {resolveMapLocation,collectionLabel,type MapLocation} from '@/lib/trail-locations';

type Trail=MapLocation;
type Entry={item:Listing;trail:Trail};
const matchTrail=resolveMapLocation;

function TrailCanvas({entries,onSelect,focusId}:{entries:Entry[];onSelect:(item:Listing)=>void;focusId:string}){
 const node=useRef<HTMLDivElement>(null),map=useRef<Leaflet.Map|null>(null),library=useRef<typeof Leaflet|null>(null);
 const [error,setError]=useState(''),[ready,setReady]=useState(false);
 useEffect(()=>{
  let disposed=false;let observer:ResizeObserver|undefined;
  setReady(false);setError('');
  import('leaflet').then(L=>{
   if(disposed||!node.current)return;
   library.current=L;
   const m=L.map(node.current,{scrollWheelZoom:false}).setView([49.9,-97.1],7);map.current=m;
   L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>'}).on('tileerror',()=>{if(!disposed)setError('Some map tiles could not load. Trail details and source maps are still available.');}).addTo(m);
   const groups=new Map<string,{entry:Entry;number:number}[]>();
   entries.forEach(({item,trail},n)=>{
    const open=()=>onSelect(item);
    if(trail.lines.length)L.polyline(trail.lines as Leaflet.LatLngExpression[][],{color:'#087b69',weight:4,opacity:.85}).on('click',open).addTo(m);
    const key=trail.position.map(x=>x.toFixed(5)).join(',');
    groups.set(key,[...(groups.get(key)||[]),{entry:{item,trail},number:n+1}]);
   });
   groups.forEach(group=>{
    const {entry:{item,trail},number}=group[0];
    const label=document.createElement('span');label.textContent=group.length>1?`${group.length} outings at ${trail.title}`:item.title;
    const marker=L.marker(trail.position as [number,number],{title:label.textContent,alt:label.textContent,icon:L.divIcon({className:'trail-pin'+(trail.approximate?' approximate':''),html:`<span>${group.length>1?group.length+'+':number}</span>`,iconSize:[32,32],iconAnchor:[16,16]})}).bindTooltip(label).addTo(m);
    if(group.length===1)marker.on('click',()=>onSelect(item));
    else{const list=document.createElement('div');list.className='map-group-popup';for(const {entry,number} of group){const b=document.createElement('button');b.textContent=`${number}. ${entry.item.title}`;b.addEventListener('click',()=>onSelect(entry.item));list.appendChild(b);}marker.bindPopup(list);}
   });
   if(entries.length)m.fitBounds(entries.map(e=>e.trail.position as [number,number]),{padding:[40,40],maxZoom:12});
   observer=new ResizeObserver(()=>m.invalidateSize());observer.observe(node.current);setReady(true);
  }).catch(()=>{if(!disposed)setError('The interactive map could not load. Use the trail list or source maps below.');});
  return()=>{disposed=true;observer?.disconnect();map.current?.remove();map.current=null;};
 },[entries,onSelect]);
 useEffect(()=>{
  const e=entries.find(e=>e.item.id===focusId);if(!e||!map.current||!library.current)return;
  const points=e.trail.lines.flat();
  if(points.length)map.current.fitBounds(points as [number,number][],{padding:[35,35],maxZoom:15});
  else map.current.setView(e.trail.position as [number,number],13);
 },[focusId,entries,ready]);
 return <div className="trail-canvas-wrap"><div className="trail-map-tools"><span>{ready?'Click a numbered marker to open an outing.':'Loading map…'}</span><Button size="sm" variant="outline" disabled={!ready||!entries.length} onClick={()=>map.current?.fitBounds(entries.map(e=>e.trail.position as [number,number]),{padding:[40,40],maxZoom:12})}><Maximize size={15}/> Fit trails</Button></div><div ref={node} className="trail-canvas" role="region" aria-label="Interactive Manitoba trail map"/>{error&&<p className="notice" role="status">{error}</p>}<p className="map-legend"><span className="route-swatch"/> Mapped trail sections <span className="pin-swatch"/> Trail or source location <span className="area-swatch"/> Approximate lake, park or landmark. Lines may cover only part of an outing.</p></div>;
}

export default function TrailMap({items,onSelect}:{items:Listing[];onSelect:(item:Listing)=>void}){
 const [distance,setDistance]=useState('Any'),[difficulty,setDifficulty]=useState('Any'),[focusId,setFocusId]=useState(''),[season,setSeason]=useState('summer'),[trailSeason,setTrailSeason]=useState('Any');
 const filtered=useMemo(()=>items.filter(i=>(trailSeason==='Any'||i.seasons?.includes(trailSeason))&&(difficulty==='Any'||(i.difficulty||'Unknown')===difficulty)&&(distance==='Any'||(i.distanceKm!=null&&(distance==='short'?i.distanceKm<=5:distance==='medium'?i.distanceKm>5&&i.distanceKm<=15:i.distanceKm>15)))),[items,distance,difficulty,trailSeason]);
 const entries=useMemo(()=>filtered.flatMap(item=>{const trail=matchTrail(item);return trail?[{item,trail}]:[];}),[filtered]);
 const unmapped=filtered.filter(i=>!matchTrail(i));
 const official='https://www.trailsmanitoba.ca/trail-info/hiking-trails-manitoba-maps/';
 const googleId=season==='summer'?'19DNqGXcQFtHyzbrP7YwLKv8_Wf-Gtkgy':'1HftjxykHeG_JOTFXC2vQIMpUBMeOLY1h';
 return <div className="trail-workspace"><Tabs defaultValue="winnigo"><TabsList aria-label="Map source"><TabsTrigger value="winnigo">Winnigo trails</TabsTrigger><TabsTrigger value="manitoba">Trails Manitoba maps</TabsTrigger></TabsList><TabsContent value="winnigo"><div className="map-filters"><label>Distance<select value={distance} onChange={e=>setDistance(e.target.value)}><option value="Any">Any distance</option><option value="short">Up to 5 km</option><option value="medium">Over 5–15 km</option><option value="long">Over 15 km</option></select></label><label>Difficulty<select value={difficulty} onChange={e=>setDifficulty(e.target.value)}>{['Any','Easy','Moderate','Challenging','Level 1 / 4','Level 2 / 4','Level 3 / 4','Level 4 / 4','Unknown'].map(d=><option key={d}>{d}</option>)}</select></label><label>Season<select value={trailSeason} onChange={e=>setTrailSeason(e.target.value)}>{['Any','Summer','Winter'].map(s=><option key={s}>{s}</option>)}</select></label><p aria-live="polite">{entries.length} mapped · {unmapped.length} awaiting a location</p></div><div className="map-layout"><TrailCanvas entries={entries} onSelect={onSelect} focusId={focusId}/><div className="map-list" aria-label="Mapped outings">{entries.length===0&&<p className="map-empty">No mapped outings match these filters. Try another category, distance or difficulty.</p>}{entries.map(({item,trail},n)=><article key={item.id} className={focusId===item.id?'map-list-item focused':'map-list-item'}><span className="map-list-number">{n+1}</span><div><button className="map-item-title" onClick={()=>onSelect(item)}>{item.title}</button><p>{item.distanceKm?`${item.distanceKm} km`:'Distance unknown'} · {item.difficulty||'Difficulty unknown'}</p><span className={'collection-label '+(item.source==='facebook'?'community':'official')}>{collectionLabel(item)}</span><p>{trail.approximate?trail.locationKind+' · '+trail.title+' (approximate)':trail.locationKind}{trail.lines.length?' · Mapped sections':trail.approximate?'':' only'}</p><div className="map-item-actions"><button onClick={()=>{setFocusId('');requestAnimationFrame(()=>setFocusId(item.id));}}>Show on map</button><button onClick={()=>onSelect(item)}>{item.source==='trails-manitoba'?'Trail details':'Photos & details'}</button><a href={trail.sources[0]} target="_blank" rel="noreferrer">Map source <ExternalLink size={12}/></a></div></div></article>)}</div></div>{unmapped.length>0&&<details className="unmapped-trails"><summary>{unmapped.length} outings without a confirmed map location</summary><p>These remain available in Winnigo. Neither a trail location nor a reliable lake or park match is available yet.</p>{unmapped.map(i=><button key={i.id} onClick={()=>onSelect(i)}>{i.title} <ExternalLink size={14}/></button>)}</details>}<p className="map-credit">Open route data: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors · ODbL</a>. Trailhead references: Manitoba Trails Project. Official trail points: Trails Manitoba. Amber markers show general areas, not confirmed entrances. <a href="/trail-map-data.json" download>Download route data</a>. Checked {data.checkedAt}. Distances and difficulty come from the listings and may describe a different route variant.</p></TabsContent><TabsContent value="manitoba"><div className="official-map-heading"><label>Season<select value={season} onChange={e=>setSeason(e.target.value)}><option value="summer">Summer</option><option value="winter">Winter</option></select></label><a href={official} target="_blank" rel="noreferrer">Open Trails Manitoba <ExternalLink size={15}/></a></div><p className="map-source-description">Explore Trails Manitoba’s wider trail network. Use the filters inside their map; Winnigo’s listing filters apply only to the Winnigo trails tab.</p><iframe key={season} className="official-trail-map" title={`Trails Manitoba ${season} trail map`} src={`https://www.google.com/maps/d/embed?mid=${googleId}`} loading="lazy" allowFullScreen/><p className="map-credit">Map maintained by Trails Manitoba and hosted by Google. If the embedded map is unavailable, <a href={official} target="_blank" rel="noreferrer">open the original page</a>.</p></TabsContent></Tabs><div className="map-resources"><span>More route information</span><a href="https://www.manitoba.ca/sd/parks/recreation-and-activities/trails/index.html" target="_blank" rel="noreferrer">Manitoba Parks <ExternalLink size={14}/></a><a href="https://www.alltrails.com/canada/manitoba" target="_blank" rel="noreferrer">Browse AllTrails <ExternalLink size={14}/></a></div></div>;
}
