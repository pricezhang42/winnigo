import {readFile} from 'node:fs/promises';
import {normalizeHikingBatch} from '../lib/social.mjs';

// The short-lived token comes from the owner's Sites connection, never Facebook cookies.
const origin='https://winnigo.wasdpyzlp.chatgpt.site';
const token=process.env.WINNIGO_AUTH_TOKEN;
if(!token)throw Error('Owner authentication is required.');
const collectorKey=(await readFile(new URL('../.sites-runtime/hiking-collector-key',import.meta.url),'utf8')).trim();
const input=JSON.parse(await readFile(process.argv[2],'utf8'));
normalizeHikingBatch(input);
const headers={'Content-Type':'application/json','Origin':origin,'OAI-Sites-Authorization':'Bearer '+token,'X-Winnigo-Collector-Key':collectorKey};
let photosSaved=0,photosFailed=0;
for(const item of input.items){
 if(!item.photoUrls)continue;
 if(!Array.isArray(item.photoUrls)||item.photoUrls.length>20)throw Error('Use up to 20 photos per listing.');
 const saved=[];
 for(const url of [...new Set(item.photoUrls)]){
  try{
   const response=await fetch(origin+'/api/photos/import',{method:'POST',redirect:'error',signal:AbortSignal.timeout(25000),headers,body:JSON.stringify({url})});
   if(!response.ok)throw Error('Photo unavailable');
   const photo=await response.json();if(!/^\/api\/photos\/[a-f0-9]{64}$/.test(photo.url))throw Error('Invalid photo response');
   saved.push(photo.url);photosSaved++;
  }catch{photosFailed++;}
 }
 if(saved.length)item.images=saved;
 delete item.photoUrls;
}
if(photosFailed){input.status='partial';input.message=(input.message||'')+` ${photosFailed} photos could not be saved; existing photos were retained.`;}
const totals={ok:true,processed:0,added:0,updated:0,photosSaved,photosFailed,status:input.status};
for(let offset=0;offset<Math.max(1,input.items.length);offset+=10){
 const response=await fetch(origin+'/api/sources',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers,body:JSON.stringify({...input,items:input.items.slice(offset,offset+10),action:'sync-hiking-manitoba'})});
 if(!response.ok)throw Error('Collection upload failed: HTTP '+response.status);
 const result=await response.json();if(result.ok!==true)throw Error('Collection upload did not confirm success.');
 totals.processed+=result.processed;totals.added+=result.added;totals.updated+=result.updated;
}
console.log(JSON.stringify(totals));
