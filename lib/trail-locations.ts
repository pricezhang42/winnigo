import {resolveMapLocation as resolve,collectionLabel} from './location-resolution.mjs';
export type MapLocation={id:string;title:string;position:number[];locationKind:string;lines:number[][][];sources:string[];geometryNote:string;approximate?:boolean};
export {collectionLabel};
export function resolveMapLocation(item:{title:string;venue:string;neighbourhood?:string;mapLocation?:MapLocation}):MapLocation|undefined{return resolve(item) as MapLocation|undefined;}
