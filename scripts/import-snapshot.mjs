import {readFile,writeFile} from 'node:fs/promises';
import {parseSource,dedupe,sources} from '../lib/connectors.mjs';
// Pass --from-files to review previously downloaded pages in /tmp/<source-id>.html.
const fromFiles=process.argv.includes('--from-files');
const all=[];const reports=[];
for(const source of sources){
 const checkedAt=new Date().toISOString();
 let html;if(fromFiles)html=await readFile(`/tmp/${source.id}.html`,'utf8');else{const response=await fetch(source.url,{headers:{'User-Agent':'Winnigo/1.0'},signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error(`${source.name}: HTTP ${response.status}`);html=await response.text();}
 const items=parseSource(source.id,html,checkedAt);if(!items.length)throw Error(`${source.name}: no listings found; inspect parser before replacing snapshot`);
 all.push(...items);reports.push({...source,count:items.length,checkedAt,status:'ok'});
}
await writeFile('lib/data/listings.json',JSON.stringify(dedupe(all),null,2));
await writeFile('lib/data/sources.json',JSON.stringify(reports,null,2));
console.log(reports.map(s=>`${s.name}: ${s.count}`).join('\n'));
