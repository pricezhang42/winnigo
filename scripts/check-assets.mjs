// Run against a running dev server or a built Worker; validates actual browser
// stylesheet/module requests rather than treating a 200 HTML response as success.
import assert from 'node:assert/strict';
const origin=process.env.WINNIGO_CHECK_ORIGIN||'http://127.0.0.1:5173';
const url=new URL(origin);
assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'This check only sends local owner credentials to loopback.');
assert.ok(process.env.WINNIGO_ADMIN_USER&&process.env.WINNIGO_ADMIN_PASSWORD,'Load owner credentials with node --env-file=.dev.vars');
const authorization='Basic '+Buffer.from(process.env.WINNIGO_ADMIN_USER+':'+process.env.WINNIGO_ADMIN_PASSWORD).toString('base64');
async function read(path,accept){
 const response=await fetch(new URL(path,url),{headers:{Authorization:authorization,Accept:accept},redirect:'error',signal:AbortSignal.timeout(30000)});
 assert.equal(response.status,200,`${path}: HTTP ${response.status}`);
 return {response,text:await response.text()};
}
const {text:html}=await read('/','text/html');
const tags=[...html.matchAll(/<(?:link|script)\b[^>]*>/g)].map(m=>m[0]);
const styles=[...new Set(tags.filter(t=>/rel="stylesheet"/.test(t)).map(t=>t.match(/href="([^"]+)"/)?.[1]).filter(Boolean))];
const modules=[...new Set(tags.filter(t=>/rel="modulepreload"|type="module"/.test(t)).map(t=>t.match(/(?:href|src)="([^"]+)"/)?.[1]).filter(Boolean))];
assert.ok(styles.length,'HTML must include stylesheets');
assert.ok(modules.length,'HTML must include browser modules');
let css='';
for(const path of styles){const result=await read(path,'text/css,*/*;q=0.1');assert.match(result.response.headers.get('content-type')||'',/text\/css/,`${path}: stylesheet MIME type`);css+=result.text;}
assert.ok(css.includes('.cards')&&css.includes('.topbar'),'Winnigo layout styles must be present');
for(const path of modules){const result=await read(path,'*/*');assert.match(result.response.headers.get('content-type')||'',/(?:javascript|ecmascript)/,`${path}: module MIME type`);assert.ok(!result.text.startsWith('<!DOCTYPE'),'Module request returned HTML');}
const localAccess=process.env.WINNIGO_AUTH_MODE==='local';
assert.equal((await fetch(new URL('/api/listings',url))).status,localAccess?200:401,'API access must match the configured authentication mode');
console.log(`Verified ${styles.length} stylesheets, ${modules.length} browser modules, layout CSS, and ${localAccess?'password-free local':'private'} API access.`);
