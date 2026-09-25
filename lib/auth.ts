import 'server-only';
import {headers} from 'next/headers';
import {principalFromHeaders} from './server/principal.mjs';
export async function getPrincipal(){return principalFromHeaders(await headers());}
export async function getOwner(){const p=await getPrincipal();return p?.role==='owner'?p:null;}
export async function getAdmin(){const p=await getPrincipal();return p&&['owner','admin'].includes(p.role)?p:null;}
