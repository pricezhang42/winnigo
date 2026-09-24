import test from 'node:test';
import assert from 'node:assert/strict';
import {isOwner,mayEnter} from '../../lib/auth-policy.mjs';
import {publishingConfig} from '../publish-config.mjs';
const env={WINNIGO_ADMIN_USER:'owner',WINNIGO_ADMIN_PASSWORD:'test-password',WINNIGO_COLLECTOR_KEY:'collector-secret'};
const owner={authorization:'Basic '+btoa('owner:test-password')};
test('explicit local mode allows loopback access and admin identity only',()=>{
 const local={...env,WINNIGO_AUTH_MODE:'local'};
 for(const host of ['localhost:5173','127.0.0.1:5173','[::1]:5173']){
  assert.equal(isOwner(new Headers({host}),local),true);
  for(const path of ['/','/admin','/api/listings','/api/photos/example'])assert.equal(mayEnter(new Request('http://'+host+path),local),true);
 }
 for(const host of ['','example.com','localhost.evil.example','127.0.0.1.evil.example'])assert.equal(isOwner(new Headers({host}),local),false);
 assert.equal(mayEnter(new Request('https://example.com',{headers:{host:'localhost'}}),local),false);
});
test('standalone access fails closed and rejects forged platform identity',()=>{
 for(const headers of [{},{authorization:'Basic !'},{authorization:'Basic '+btoa('owner:wrong')},{'oai-authenticated-user-id':'forged','oai-authenticated-user-email':'forged@example.com'}])assert.equal(isOwner(new Headers(headers),env),false);
 assert.equal(isOwner(new Headers(owner),{}),false);
 assert.equal(isOwner(new Headers(owner),env),true);
 for(const path of ['/','/admin','/api/listings','/api/photos/'+'a'.repeat(64),'/_next/static/app.js']){
  assert.equal(mayEnter(new Request('https://test.example'+path),env),false);
  assert.equal(mayEnter(new Request('https://test.example'+path,{headers:owner}),env),true);
 }
});
test('collector key is scoped to import POST endpoints only',()=>{
 const headers={'x-winnigo-collector-key':env.WINNIGO_COLLECTOR_KEY};
 for(const path of ['/api/sources','/api/photos/import']){
  assert.equal(mayEnter(new Request('https://test.example'+path,{headers,method:'POST'}),env),true);
  assert.equal(mayEnter(new Request('https://test.example'+path,{headers}),env),false);
 }
 assert.equal(mayEnter(new Request('https://test.example/api/listings',{headers}),env),false);
});
test('upload configuration is local by default and explicit for remote hosts',()=>{
 const config=publishingConfig(env);assert.equal(config.origin,'http://127.0.0.1:5173');assert.equal(config.headers['OAI-Sites-Authorization'],undefined);
 assert.equal(publishingConfig({...env,WINNIGO_ORIGIN:'https://private.example'}).origin,'https://private.example');
 for(const origin of ['http://remote.example','https://user:secret@remote.example','https://remote.example/path','https://remote.example/?q=1'])assert.throws(()=>publishingConfig({...env,WINNIGO_ORIGIN:origin}));
 assert.throws(()=>publishingConfig({}));
 assert.throws(()=>publishingConfig({...env,WINNIGO_ORIGIN:'https://winnigo.example.chatgpt.site'}));
});
