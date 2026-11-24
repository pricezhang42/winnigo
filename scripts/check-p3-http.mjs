// P3 HTTP access checks against a running QA server (see docs/16-p3-accounts.md). Requires a
// *_p3_qa database; creates synthetic accounts only.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { loadLocalEnv } from './load-env.mjs';
import { database } from '../lib/server/postgres.mjs';
import { issueCredential, bootstrapOwner } from '../lib/server/access.mjs';
loadLocalEnv();
const origin = process.env.WINNIGO_ORIGIN,
  pool = database(),
  // With WINNIGO_PUBLIC_BROWSING=enabled (docs/31), signed-out reads see public discoveries only.
  publicBrowsing = process.env.WINNIGO_PUBLIC_BROWSING === 'enabled',
  // With WINNIGO_SIGNUP=open (docs/31), an uninvited email can register (and must still verify).
  openSignup = process.env.WINNIGO_SIGNUP === 'open';
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
const cookies = (response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
async function verify(email) {
  const files = await readdir('.winnigo/p3-mail');
  for (const file of files) {
    const message = JSON.parse(await readFile('.winnigo/p3-mail/' + file));
    if (message.to === email && message.kind === 'verify') {
      const response = await fetch(message.url, { redirect: 'manual' });
      assert.ok([200, 302].includes(response.status));
      return;
    }
  }
  throw Error('Verification mail missing');
}
try {
  await pool.query('TRUNCATE auth_rate_limit,request_limits');
  for (const email of [ownerEmail, memberEmail])
    await pool.query('INSERT INTO account_invitations(email) VALUES($1)', [email]);
  if (publicBrowsing) {
    const anonymous = await request('/api/listings');
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.headers.get('x-robots-tag'), 'noindex, nofollow');
    const page = await anonymous.json();
    assert.ok(page.items.every((item) => !['facebook', 'instagram'].includes(item.source)));
    assert.ok(!page.communitySources.length, 'visitors are not shown community sources');
    assert.equal((await request('/')).status, 200);
    for (const path of ['/admin', '/account']) assert.equal((await request(path)).status, 307);
    for (const path of ['/api/me', '/api/runs', '/api/event-changes', '/api/sources'])
      assert.equal((await request(path)).status, 401, path);
    assert.equal((await request('/api/sources', { action: 'refresh' })).status, 401);
  } else {
    assert.equal((await request('/api/listings')).status, 401);
    assert.equal((await request('/')).status, 307);
  }
  assert.equal((await request('/login')).status, 200);
  for (const path of ['/privacy', '/terms']) assert.equal((await request(path)).status, 200, path);
  const uninvited = `uninvited-${stamp}@example.test`;
  await request('/api/auth/sign-up/email', { email: uninvited, password, name: 'Uninvited QA' });
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM auth_user WHERE email=$1', [uninvited])).rows[0]
      .n,
    openSignup ? 1 : 0,
  );
  assert.equal((await request('/api/users')).status, 401);
  for (const email of [ownerEmail, memberEmail]) {
    const response = await request('/api/auth/sign-up/email', {
      email,
      password,
      name: 'Browser QA',
    });
    assert.equal(response.status, 200, await response.clone().text());
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
  // Saved items in the account (docs/31): same origin, signed in, and the Saved tab reads them.
  const publicItem = (await (await request('/api/listings', null, member)).json()).items[0].id;
  const savePath = '/api/me/saved/' + encodeURIComponent(publicItem);
  const put = (headers) => fetch(origin + savePath, { method: 'PUT', headers, redirect: 'manual' });
  assert.equal((await put({ Origin: origin })).status, 401);
  assert.equal((await put({ Origin: 'https://evil.example', ...member })).status, 403);
  assert.equal((await put({ Origin: origin, ...member })).status, 200);
  assert.deepEqual((await (await request('/api/me/saved', null, member)).json()).ids, [publicItem]);
  const savedTab = await (await request('/api/listings?tab=Saved', null, member)).json();
  assert.deepEqual(
    savedTab.items.map((item) => item.id),
    [publicItem],
  );
  assert.deepEqual((await (await request('/api/me/saved', null, owner)).json()).ids, []);
  assert.equal(
    (await fetch(origin + savePath, { method: 'DELETE', headers: { Origin: origin, ...member } }))
      .status,
    200,
  );
  assert.deepEqual((await (await request('/api/me/saved', null, member)).json()).ids, []);
  const imported = await request(
    '/api/me/saved',
    { action: 'import', ids: [publicItem, 'not-a-listing'] },
    member,
  );
  assert.deepEqual((await imported.json()).ids, [publicItem]);

  // The account page (docs/31): server-read devices and saved count, no session tokens, and
  // `update-user` changes only a bounded display name.
  const accountPage = await (await request('/account', null, member)).text();
  assert.match(accountPage, /This device/);
  assert.match(accountPage, /1 saved discovery/);
  const memberToken = decodeURIComponent(memberCookie.split('session_token=')[1]).split('.')[0];
  assert.ok(!accountPage.includes(memberToken));
  for (const body of [{ name: 'QA', image: 'https://example.test/x.png' }, { name: ' ' }])
    assert.equal((await request('/api/auth/update-user', body, member)).status, 400);
  assert.equal((await request('/api/auth/update-user', { name: 'Member QA' }, member)).status, 200);

  // The Users panel (docs/31): owner only, same origin only.
  const users = await request('/api/users', null, owner);
  assert.equal(users.status, 200);
  const memberAccount = (await users.json()).users.find((u) => u.email === memberEmail);
  assert.equal(memberAccount.role, 'user');
  assert.equal((await request('/api/users', null, member)).status, 401);
  const roleChange = { action: 'update', userId: memberAccount.id, role: 'admin' };
  assert.equal((await request('/api/users', roleChange, member)).status, 401);
  assert.equal(
    (
      await fetch(origin + '/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', ...owner },
        body: JSON.stringify(roleChange),
      })
    ).status,
    403,
  );
  assert.equal((await request('/api/users', roleChange, owner)).status, 200);
  assert.equal((await request('/api/users', { ...roleChange, role: 'user' }, owner)).status, 200);
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
  // A collector token is not a reader: refused, or only a visitor under public browsing.
  if (publicBrowsing) {
    const asVisitor = await request('/api/listings', null, collector);
    assert.equal(asVisitor.status, 200);
    assert.ok((await asVisitor.json()).items.every((item) => item.source !== 'facebook'));
    assert.equal((await request('/api/sources', null, collector)).status, 401);
    assert.equal((await request(photo, null, collector)).status, 404);
  } else
    for (const route of ['/api/listings', '/api/sources', photo])
      assert.equal((await request(route, null, collector)).status, 401);
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
  // A revoked session is signed out: refused, or a visitor when public browsing is enabled.
  const revoked = await request('/api/listings', null, member);
  assert.equal(revoked.status, publicBrowsing ? 200 : 401);
  await mkdir('.winnigo/p3-evidence', { recursive: true });
  await writeFile(
    '.winnigo/p3-evidence/browser-account.json',
    JSON.stringify({ ownerEmail, password, ownerCookie }),
    { mode: 0o600 },
  );
  console.log(
    (publicBrowsing ? 'Public browsing on. ' : '') +
      (openSignup ? 'Open sign-up on. ' : '') +
      'P3 HTTP checks passed: saved items, account page, users panel, session gate, filtered counts/media, grants/revocation, own profile, origin checks and scoped/revoked collector credentials.',
  );
} finally {
  await pool.end();
}
