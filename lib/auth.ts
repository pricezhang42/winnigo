import {env} from 'cloudflare:workers';
import {headers} from 'next/headers';
import {isOwner} from './auth-policy.mjs';
export async function getOwner(){return isOwner(await headers(),env)?{userId:'owner'}:null;}
