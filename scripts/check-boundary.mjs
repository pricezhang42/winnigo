import assert from 'node:assert/strict';
import { issueCredential } from '../lib/server/access.mjs';
import { database } from '../lib/server/postgres.mjs';
import { loadLocalEnv } from './load-env.mjs';
loadLocalEnv();
const origin = process.env.WINNIGO_CHECK_ORIGIN || 'http://127.0.0.1:5182';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname));
const owner = {
  Authorization:
    'Basic ' +
    Buffer.from(process.env.WINNIGO_ADMIN_USER + ':' + process.env.WINNIGO_ADMIN_PASSWORD).toString(
      'base64',
    ),
};
const issued = await issueCredential({ source: 'facebook', label: 'Boundary QA' });
const collector = { 'x-winnigo-collector-key': issued.token };
try {
  const get = (path, headers = {}) => fetch(origin + path, { headers, redirect: 'manual' });
  const sample = await (await get('/api/listings?query=P0%20Betula', owner)).json();
  const photo = sample.items[0]?.images?.[0];
  assert.ok(photo, 'QA photo fixture required');
  for (const path of ['/', '/admin', '/api/listings', '/api/sources', photo]) {
    assert.equal((await get(path)).status, 401, path + ' anonymous');
    assert.equal((await get(path, collector)).status, 401, path + ' collector');
    assert.equal(
      (await get(path, { 'x-middleware-subrequest': 'proxy:proxy:proxy:proxy:proxy' })).status,
      401,
      path + ' forged internal header',
    );
    assert.equal((await get(path, owner)).status, 200, path + ' owner');
  }
  const html = await (await get('/', owner)).text();
  const assets = [...html.matchAll(/(?:src|href)="(\/_next\/[^" ]+)"/g)].map((m) => m[1]);
  assert.ok(assets.length);
  for (const path of new Set(assets))
    assert.equal((await get(path)).status, 401, 'Private static asset');
  const post = (headers, body) =>
    fetch(origin + '/api/sources', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post(collector, { action: 'update', id: 'p0-community', hidden: true })).status,
    403,
  );
  assert.equal(
    (
      await fetch(origin + '/api/sources', {
        method: 'POST',
        headers: { ...owner, 'Content-Type': 'application/json', Origin: 'https://other.example' },
        body: JSON.stringify({ action: 'update', id: 'p0-community', hidden: true }),
      })
    ).status,
    403,
  );
  assert.equal((await get('/api/health')).status, 200);
  console.log(
    'Basic mode: owner pages/API/media allowed; anonymous, collector reads, internal-header bypass and cross-origin mutations denied; static assets gated.',
  );
} finally {
  await database().query('DELETE FROM service_credentials WHERE id=$1', [issued.id]);
  await database().end();
}
