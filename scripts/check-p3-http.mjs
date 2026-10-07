import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { loadLocalEnv } from './load-env.mjs';
import { database } from '../lib/server/postgres.mjs';
import { issueCredential, bootstrapOwner } from '../lib/server/access.mjs';
loadLocalEnv();
const origin = process.env.WINNIGO_ORIGIN,
  pool = database();
assert.ok(new URL(process.env.DATABASE_URL).pathname.endsWith('_p3_qa'));
assert.ok(['localhost', '127.0.0.1'].includes(new URL(origin).hostname));
const stamp = Date.now(),
  password = 'Synthetic-qa-password-123',
  ownerEmail = `owner-${stamp}@example.test`,
  memberEmail = `member-${stamp}@example.test`;
async function request(path, body, headers = {}) {
  return fetch(origin + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'manual',
  });
}
const cookies = (r) =>
  r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
async function verify(email) {
  const files = await readdir('.winnigo/p3-mail');
  for (const f of files) {
    const m = JSON.parse(await readFile('.winnigo/p3-mail/' + f));
    if (m.to === email && m.kind === 'verify') {
      const r = await fetch(m.url, { redirect: 'manual' });
      assert.ok([200, 302].includes(r.status));
      return;
    }
  }
  throw Error('Verification mail missing');
}
try {
  await pool.query('TRUNCATE auth_rate_limit,request_limits');
  for (const email of [ownerEmail, memberEmail])
    await pool.query('INSERT INTO account_invitations(email) VALUES($1)', [email]);
  assert.equal((await request('/api/listings')).status, 401);
  assert.equal((await request('/')).status, 307);
  assert.equal((await request('/login')).status, 200);
  for (const email of [ownerEmail, memberEmail]) {
    const r = await request('/api/auth/sign-up/email', { email, password, name: 'Browser QA' });
    assert.equal(r.status, 200, await r.clone().text());
    await verify(email);
  }
  // QA database may contain a previous owner; release that synthetic role only.
  await pool.query("UPDATE user_access SET role='user' WHERE role='owner'");
  await bootstrapOwner(ownerEmail, pool);
  const ownerCookie = cookies(
      await request('/api/auth/sign-in/email', { email: ownerEmail, password }),
    ),
    memberCookie = cookies(
      await request('/api/auth/sign-in/email', { email: memberEmail, password }),
    );
  assert.ok(ownerCookie.includes('session_token'));
  assert.ok(memberCookie.includes('session_token'));
  const owner = { Cookie: ownerCookie },
    member = { Cookie: memberCookie };
  const me = await (await request('/api/me', null, member)).json();
  assert.equal(me.role, 'user');
  const ownerResults = await (
    await request('/api/listings?collection=Community%20Highlights', null, owner)
  ).json();
  assert.ok(ownerResults.total > 0);
  const photo = ownerResults.items[0].images[0];
  const memberResults = await (
    await request('/api/listings?collection=Community%20Highlights', null, member)
  ).json();
  assert.equal(memberResults.total, 0);
  assert.equal(memberResults.items.length, 0);
  assert.equal(memberResults.communitySources.length, 0);
  assert.equal((await request(photo, null, member)).status, 404);
  assert.equal((await request('/api/listings/p0-community', null, member)).status, 404);
  assert.equal((await request('/api/sources', null, member)).status, 401);
  assert.equal(
    (
      await request(
        '/api/sources',
        { action: 'update', id: 'p0-community', title: 'Unauthorized' },
        member,
      )
    ).status,
    401,
  );
  assert.equal((await request('/api/me?userId=other', null, member)).status, 200);
  assert.equal(
    (await (await request('/api/me?userId=other', null, member)).json()).userId,
    me.userId,
  );
  await pool.query("INSERT INTO listing_grants VALUES($1,'p0-community')", [me.userId]);
  assert.equal((await request(photo, null, member)).status, 200);
  assert.equal(
    (await (await request('/api/listings?collection=Community%20Highlights', null, member)).json())
      .total,
    1,
  );
  await pool.query('DELETE FROM listing_grants WHERE user_id=$1', [me.userId]);
  assert.equal((await request(photo, null, member)).status, 404);
  assert.equal(
    (
      await request(
        '/api/auth/sign-in/email',
        { email: memberEmail, password },
        { Origin: 'https://attacker.example' },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        '/api/sources',
        { action: 'update', id: 'p0-community', hidden: true },
        { ...owner, Origin: 'https://attacker.example' },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request('/api/auth/sign-in/email', {
        email: memberEmail,
        password,
        padding: 'x'.repeat(17000),
      })
    ).status,
    413,
  );
  assert.equal((await request('/api/photos/import', { url: 'x'.repeat(8100) }, owner)).status, 413);
  const credential = await issueCredential({ source: 'facebook', label: 'HTTP QA' }, pool),
    collector = { 'x-winnigo-collector-key': credential.token };
  for (const p of ['/api/listings', '/api/sources', photo])
    assert.equal((await request(p, null, collector)).status, 401);
  assert.equal(
    (
      await request(
        '/api/sources',
        { action: 'update', id: 'p0-community', hidden: true },
        collector,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        '/api/sources',
        { action: 'sync-hiking-manitoba', status: 'ok', items: [] },
        collector,
      )
    ).status,
    200,
  );
  await pool.query('UPDATE service_credentials SET revoked_at=now() WHERE id=$1', [credential.id]);
  assert.equal(
    (
      await request(
        '/api/sources',
        { action: 'sync-hiking-manitoba', status: 'ok', items: [] },
        collector,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await request(
        '/api/sources',
        { action: 'sync-hiking-manitoba', status: 'ok', items: [] },
        { 'x-winnigo-collector-key': process.env.WINNIGO_COLLECTOR_KEY },
      )
    ).status,
    401,
  );
  await pool.query('DELETE FROM auth_session WHERE "userId"=$1', [me.userId]);
  assert.equal((await request('/api/listings', null, member)).status, 401);
  await mkdir('.winnigo/p3-evidence', { recursive: true });
  await writeFile(
    '.winnigo/p3-evidence/browser-account.json',
    JSON.stringify({ ownerEmail, password, ownerCookie }),
    { mode: 0o600 },
  );
  console.log(
    'P3 HTTP checks passed: session gate, filtered counts/media, grants/revocation, own profile, origin checks and scoped/revoked collector credentials.',
  );
} finally {
  await pool.end();
}
