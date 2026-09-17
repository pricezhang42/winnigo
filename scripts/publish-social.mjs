import {readFile} from 'node:fs/promises';
import {normalizeHikingBatch} from '../lib/social.mjs';

// The short-lived token comes from the owner's Sites connection, never Facebook cookies.
const origin='https://winnigo.wasdpyzlp.chatgpt.site';
const token=process.env.WINNIGO_AUTH_TOKEN;
if(!token)throw Error('Owner authentication is required.');
const collectorKey=(await readFile(new URL('../.sites-runtime/hiking-collector-key',import.meta.url),'utf8')).trim();
const input=JSON.parse(await readFile(process.argv[2],'utf8'));
normalizeHikingBatch(input);
const response=await fetch(origin+'/api/sources',{
 method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),
 headers:{'Content-Type':'application/json','Origin':origin,'OAI-Sites-Authorization':'Bearer '+token,'X-Winnigo-Collector-Key':collectorKey},
 body:JSON.stringify({...input,action:'sync-hiking-manitoba'})
});
if(!response.ok)throw Error('Collection upload failed: HTTP '+response.status);
const result=await response.json();
if(result.ok!==true)throw Error('Collection upload did not confirm success.');
console.log(JSON.stringify(result));
