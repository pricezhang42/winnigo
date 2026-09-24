// Run only against a disposable checkout, never the working app's database.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {normalizeHikingBatch} from '../../lib/social.mjs';
import {sources} from '../../lib/connectors.mjs';
const target=resolve(process.argv[2]||'');assert.match(target,/^\/tmp\/winnigo-p0-legacy\.[A-Za-z0-9]+$/);
const f=JSON.parse(readFileSync(new URL('../../scripts/fixtures/p0-discovery.json',import.meta.url)));
const official=JSON.parse(readFileSync(new URL('../../lib/data/official-trails.json',import.meta.url)));
const now=new Date().toISOString();const quote=x=>"'"+String(x).replaceAll("'","''")+"'";
const community={...normalizeHikingBatch({status:'ok',items:[f.community]},now).items[0],id:'p0-community'};
community.image=community.images[0];
const hidden={...community,id:'p0-hidden',title:'P0 hidden fixture',url:community.url.replace('999999999999001','999999999999003')};
const corrected={...community,id:'p0-override',title:'P0 source title',url:community.url.replace('999999999999001','999999999999004')};
let sql=sources.map(s=>`INSERT OR REPLACE INTO sources(id,checked_at,attempted_at,count,status) VALUES(${quote(s.id)},${quote(now)},${quote(now)},0,'ok');`).join('\n');
for(const s of [{id:'trails-manitoba',checkedAt:official.source.checkedAt,count:official.items.length},{id:'facebook',checkedAt:now,count:3}])sql+=`\nINSERT OR REPLACE INTO sources(id,checked_at,attempted_at,count,status) VALUES(${quote(s.id)},${quote(s.checkedAt)},${quote(now)},${s.count},'ok');`;
for(const item of [...official.items,community,hidden,corrected])sql+=`\nINSERT OR REPLACE INTO listings(id,source,payload,hidden,override) VALUES(${quote(item.id)},${quote(item.source)},${quote(JSON.stringify(item))},${item.id==='p0-hidden'?1:0},${item.id==='p0-override'?quote(JSON.stringify({title:'P0 owner correction',price:5})):'NULL'});`;
const file=target+'/.winnigo/p0-fixtures.sql';writeFileSync(file,sql);
function wrangler(args){const r=spawnSync(target+'/node_modules/.bin/wrangler',args,{cwd:target,stdio:'pipe',encoding:'utf8'});if(r.status!==0)throw Error(r.stderr||r.stdout);}
wrangler(['d1','execute','DB','--local','--persist-to','.wrangler/state','--file',file]);
// Locally generated SVGs are harmless visual test fixtures (never private photos).
for(const [letter,color] of [['a','#17654d'],['b','#de9d3b']]){
 const image=target+'/.winnigo/p0-'+letter+'.svg';writeFileSync(image,`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="${color}"/><text x="60" y="200" font-size="32" fill="white">Synthetic P0 photo ${letter}</text></svg>`);
 wrangler(['r2','object','put','winnigo-photos/photos/'+letter.repeat(64),'--file',image,'--content-type','image/svg+xml','--local','--persist-to','.wrangler/state']);
}
console.log('Seeded disposable legacy database and two synthetic gallery images.');
