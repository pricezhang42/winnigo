import routes from '@/lib/data/trail-map.json';
import anchors from '@/lib/data/trail-map-anchors.json';

export type MapLocation={id:string;title:string;position:number[];locationKind:string;lines:number[][][];sources:string[];geometryNote:string;approximate?:boolean};
type LocatedItem={title:string;venue:string;neighbourhood?:string;mapLocation?:MapLocation};
const normalize=(s:string)=>s.toLowerCase().replace(/[’‘]/g,"'");
const fallback=(id:string,title:string,position:number[],kind:string,source:string):MapLocation=>({id,title,position,locationKind:kind,lines:[],sources:[source],geometryNote:'General area only. The trail entrance, meeting point and route are not confirmed.',approximate:true});
const areas=[
 {match:'Betula Lake',location:fallback('betula-lake','Betula Lake',[50.0813478,-95.577846],'Lake area','https://www.openstreetmap.org/relation/7635483')},
 {match:'Upper Coca Cola Falls',location:fallback('coca-cola-falls','Upper Coca Cola Falls',[50.4757233,-95.9859258],'Waterfall area','https://www.openstreetmap.org/node/848941511')},
 {match:'Whiteshell',location:fallback('whiteshell-park','Whiteshell Provincial Park',[50.0220631,-95.5559803],'Park area','https://www.openstreetmap.org/relation/2027251')}
];
export function resolveMapLocation(item:LocatedItem):MapLocation|undefined{
 if(item.mapLocation)return item.mapLocation;
 const name=normalize(`${item.title} ${item.venue}`);
 const route=routes.trails.find(t=>name.includes(normalize(t.match)));
 if(route)return route;
 const anchor=anchors.find(t=>name.includes(normalize(t.match)));
 if(anchor)return anchor;
 const areaName=normalize(`${item.title} ${item.venue} ${item.neighbourhood||''}`);
 return areas.find(a=>areaName.includes(normalize(a.match)))?.location;
}
export function collectionLabel(item:{source:string}){return item.source==='facebook'?'Community Highlights':item.source==='trails-manitoba'?'Official Trails':'';}
