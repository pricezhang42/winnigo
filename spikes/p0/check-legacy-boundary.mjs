import assert from 'node:assert/strict';
const origin=process.env.WINNIGO_CHECK_ORIGIN;
const parsed=new URL(origin);assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.port,'5178');
const owner='Basic '+Buffer.from(process.env.WINNIGO_ADMIN_USER+':'+process.env.WINNIGO_ADMIN_PASSWORD).toString('base64');
const collector={'x-winnigo-collector-key':process.env.WINNIGO_COLLECTOR_KEY};
for(const path of ['/','/api/listings','/admin','/api/photos/'+'a'.repeat(64)]){
 assert.equal((await fetch(origin+path)).status,401);
 assert.equal((await fetch(origin+path,{headers:{Authorization:owner}})).status,200);
 assert.equal((await fetch(origin+path,{headers:collector})).status,401);
}
const update=await fetch(origin+'/api/sources',{method:'POST',headers:{...collector,'Content-Type':'application/json',Origin:origin},body:JSON.stringify({action:'update',id:'p0-community',hidden:true})});
assert.equal(update.status,403);
console.log('Built Worker: anonymous/collector reads denied; owner pages/API/photo reads allowed; collector admin update denied.');
