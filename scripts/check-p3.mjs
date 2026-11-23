// P3 integration check (npm run check:p3): accounts, verification, sessions, owner bootstrap,
// grants, collector credentials and rate limits in a temporary PostgreSQL schema.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { serviceConfig } from './check-services.mjs';
import { createAccounts } from '../lib/server/accounts.mjs';
import { PostgresRepository } from '../lib/server/postgres-repository.mjs';
import {
  bootstrapOwner,
  issueCredential,
  serviceCredential,
  canReadMedia,
  rateLimit,
} from '../lib/server/access.mjs';
const schema = 'p3_test_' + Date.now(),
  config = serviceConfig(),
  admin = new Pool({ connectionString: config.connectionString });
const pool = new Pool({
    connectionString: config.connectionString,
    options: `-c search_path=${schema}`,
    max: 10,
  }),
  mail = [];
const origin = 'http://127.0.0.1:5193',
  env = {
    ...process.env,
    WINNIGO_AUTH_MODE: 'session',
    WINNIGO_ORIGIN: origin,
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
  };
let auth;
async function call(path, body, cookie) {
  const response = await auth.handler(
    new Request(origin + '/api/auth/' + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Origin: origin,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
  return response;
}
const credentials = {
  name: 'QA Member',
  email: 'member@example.test',
  password: 'Unique-test-password-123',
};
const cookieOf = (reply) =>
  reply.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  for (const migration of (await readdir('migrations/postgres'))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    await pool.query(await readFile('migrations/postgres/' + migration, 'utf8'));
  auth = createAccounts({ pool, env, sendMail: async (m) => mail.push(m) });
  assert.ok([200, 403].includes((await call('sign-up/email', credentials)).status));
  assert.equal((await pool.query('SELECT count(*) FROM auth_user')).rows[0].count, '0');
  await pool.query('INSERT INTO account_invitations(email) VALUES($1),($2),($3)', [
    credentials.email,
    'owner@example.test',
    'other@example.test',
  ]);
  let reply = await call('sign-up/email', credentials);
  assert.equal(reply.status, 200, await reply.clone().text());
  assert.equal((await call('sign-in/email', credentials)).status, 403);
  const verify = mail.find((m) => m.kind === 'verify');
  assert.ok(verify);
  assert.ok(!verify.url.includes(credentials.password));
  reply = await auth.handler(new Request(verify.url));
  assert.ok([200, 302].includes(reply.status), await reply.clone().text());
  reply = await call('sign-in/email', credentials);
  assert.equal(reply.status, 200, await reply.clone().text());
  const cookie = cookieOf(reply);
  assert.ok(cookie.includes('session_token'));
  assert.ok(reply.headers.get('set-cookie').includes('HttpOnly'));
  assert.ok(reply.headers.get('set-cookie').includes('SameSite=Lax'));
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  const userId = session.user.id;
  assert.equal(
    (await pool.query('SELECT role FROM user_access WHERE user_id=$1', [userId])).rows[0].role,
    'user',
  );
  const second = { ...credentials, email: 'other@example.test' };
  await call('sign-up/email', second);
  await auth.handler(
    new Request(mail.find((m) => m.to === second.email && m.kind === 'verify').url),
  );
  const otherCookie = cookieOf(await call('sign-in/email', second));
  const other = await auth.api.getSession({ headers: new Headers({ cookie: otherCookie }) });
  reply = await call('update-user', { name: 'Own profile change', userId: other.user.id }, cookie);
  assert.equal(reply.status, 200);
  assert.equal(
    (await pool.query('SELECT name FROM auth_user WHERE id=$1', [other.user.id])).rows[0].name,
    'QA Member',
  );
  assert.equal(
    (await pool.query('SELECT name FROM auth_user WHERE id=$1', [userId])).rows[0].name,
    'Own profile change',
  );
  // Arbitrary role input is ignored; owner bootstrap requires a verified named account.
  const ownerCred = { ...credentials, email: 'owner@example.test', role: 'owner' };
  await pool.query('TRUNCATE auth_rate_limit');
  reply = await call('sign-up/email', ownerCred);
  assert.equal(reply.status, 200, await reply.clone().text());
  await assert.rejects(bootstrapOwner(ownerCred.email, pool), /verified/);
  await auth.handler(
    new Request(mail.find((m) => m.to === ownerCred.email && m.kind === 'verify').url),
  );
  await bootstrapOwner(ownerCred.email, pool);
  await assert.rejects(bootstrapOwner(second.email, pool), /already/);
  const repo = new PostgresRepository(pool),
    member = { userId, role: 'user' },
    otherPrincipal = { userId: other.user.id, role: 'user' },
    owner = { userId: 'owner-test', role: 'owner' };
  const make = (id, source) => ({
    id,
    source,
    hidden: false,
    override: {},
    payload: {
      id,
      source,
      title: 'Distinct ' + id,
      venue: 'Test ' + id,
      url: 'https://example.test/' + id,
      status: 'active',
      category: 'Hiking',
      neighbourhood: source === 'facebook' ? 'Secret Area' : 'Public Area',
      price: null,
    },
  });
  await repo.importRecords([make('public', 'public-source'), make('private', 'facebook')]);
  assert.equal((await repo.search({ principal: member })).total, 1);
  assert.deepEqual((await repo.search({ principal: member })).areas, ['Public Area']);
  assert.equal((await repo.search({ principal: member, query: 'private' })).total, 0);
  assert.equal(await repo.detail('private', { principal: member }), null);
  assert.equal((await repo.search({ principal: owner })).total, 2);
  assert.equal((await repo.search()).total, 0);
  // A visitor (public browsing, docs/31) sees public rows only, with matching facets and counts.
  const visitor = { role: 'visitor' };
  assert.deepEqual(
    (await repo.search({ principal: visitor })).items.map((i) => i.id),
    ['public'],
  );
  assert.deepEqual((await repo.search({ principal: visitor })).areas, ['Public Area']);
  assert.equal(await repo.detail('private', { principal: visitor }), null);
  assert.ok(await repo.detail('public', { principal: visitor }));
  assert.ok(
    !(await repo.search({ principal: visitor })).reports.some((r) => r.id === 'facebook'),
    'visitors get no report for restricted sources',
  );
  const photo = 'a'.repeat(64);
  await pool.query(
    "INSERT INTO media(id,object_key,content_type,size,status) VALUES($1,$2,'image/png',10,'ready')",
    [photo, 'photos/' + photo],
  );
  await pool.query("INSERT INTO listing_media VALUES('private',$1,0)", [photo]);
  assert.equal(await canReadMedia(photo, member, pool), false);
  assert.equal(await canReadMedia(photo, visitor, pool), false);
  const publicPhoto = 'b'.repeat(64);
  await pool.query(
    "INSERT INTO media(id,object_key,content_type,size,status) VALUES($1,$2,'image/png',10,'ready')",
    [publicPhoto, 'photos/' + publicPhoto],
  );
  await pool.query("INSERT INTO listing_media VALUES('public',$1,0)", [publicPhoto]);
  assert.equal(await canReadMedia(publicPhoto, visitor, pool), true);
  await pool.query("INSERT INTO listing_grants VALUES($1,'private')", [userId]);
  assert.equal((await repo.search({ principal: member })).total, 2);
  assert.equal(await canReadMedia(photo, member, pool), true);
  assert.equal(await canReadMedia(photo, otherPrincipal, pool), false);
  await pool.query('DELETE FROM listing_grants WHERE user_id=$1', [userId]);
  assert.equal(await canReadMedia(photo, member, pool), false);
  await pool.query("INSERT INTO source_grants VALUES($1,'facebook')", [userId]);
  assert.equal((await repo.search({ principal: member })).total, 2);
  await pool.query('DELETE FROM source_grants WHERE user_id=$1', [userId]);
  assert.equal((await repo.search({ principal: { ...member, role: 'admin' } })).total, 1);
  // Collected events follow the same access rules: a restricted event needs a grant.
  await pool.query("INSERT INTO sources(id) VALUES('private-events')");
  await pool.query(
    `INSERT INTO events(id,source,source_key,page_url,event_url,title,category,visibility,checked_at)
     VALUES('private-program','private-events','key:1','https://example.test/p',
       'https://example.test/p','Private program','Experiences','restricted',now())`,
  );
  await pool.query(
    "INSERT INTO event_sessions VALUES('private-program','a','2099-06-01','2099-06-01')",
  );
  assert.equal((await repo.search({ principal: member, query: 'Private program' })).total, 0);
  assert.equal(await repo.detail('private-program', { principal: member }), null);
  assert.equal((await repo.search({ principal: owner, query: 'Private program' })).total, 1);
  await pool.query("INSERT INTO source_grants VALUES($1,'private-events')", [userId]);
  assert.equal(
    (await repo.availability('private-program', '2099-06-01', { principal: member })).status,
    'available',
  );
  assert.equal(
    (await repo.search({ principal: otherPrincipal, query: 'Private program' })).total,
    0,
  );
  await pool.query('DELETE FROM source_grants WHERE user_id=$1', [userId]);
  const token = await issueCredential({ source: 'facebook', label: 'QA' }, pool);
  assert.ok(
    (await serviceCredential(new Headers({ 'x-winnigo-collector-key': token.token }), pool)).id,
  );
  assert.notEqual(
    (await pool.query('SELECT token_hash FROM service_credentials WHERE id=$1', [token.id])).rows[0]
      .token_hash,
    token.token,
  );
  await pool.query('UPDATE service_credentials SET revoked_at=now() WHERE id=$1', [token.id]);
  assert.equal(
    await serviceCredential(new Headers({ 'x-winnigo-collector-key': token.token }), pool),
    null,
  );
  assert.equal(await rateLimit('test', 1, 60, pool), true);
  assert.equal(await rateLimit('test', 1, 60, pool), false);
  // Another user cannot revoke this user's session. Reset invalidates existing sessions.
  reply = await call('revoke-session', { token: session.session.token }, otherCookie);
  assert.ok([200, 400, 403].includes(reply.status));
  assert.ok(await auth.api.getSession({ headers: new Headers({ cookie }) }));
  assert.equal(
    (
      await call('request-password-reset', {
        email: credentials.email,
        redirectTo: origin + '/account/reset',
      })
    ).status,
    200,
  );
  const reset = mail.find((m) => m.kind === 'reset'),
    resetToken = new URL(reset.url).pathname.split('/').pop();
  assert.ok(resetToken);
  reply = await call('reset-password', {
    token: resetToken,
    newPassword: 'Replacement-password-456',
  });
  assert.equal(reply.status, 200, await reply.clone().text());
  assert.equal(await auth.api.getSession({ headers: new Headers({ cookie }) }), null);
  assert.equal((await call('sign-in/email', credentials)).status, 401);
  reply = await call('sign-in/email', { ...credentials, password: 'Replacement-password-456' });
  assert.equal(reply.status, 200);
  const newCookie = cookieOf(reply);
  reply = await call('sign-out', {}, newCookie);
  assert.equal(reply.status, 200);
  assert.equal(await auth.api.getSession({ headers: new Headers({ cookie: newCookie }) }), null);
  // Email-confirmed account deletion cascades access and sessions.
  await pool.query("INSERT INTO source_grants VALUES($1,'facebook')", [other.user.id]);
  reply = await call('delete-user', { callbackURL: origin + '/login' }, otherCookie);
  assert.equal(reply.status, 200, await reply.clone().text());
  const deletion = mail.find((m) => m.kind === 'delete');
  reply = await auth.handler(new Request(deletion.url, { headers: { cookie: otherCookie } }));
  assert.ok([200, 302].includes(reply.status), await reply.clone().text());
  assert.equal(
    (await pool.query('SELECT 1 FROM auth_user WHERE id=$1', [other.user.id])).rowCount,
    0,
  );
  assert.equal(
    (await pool.query('SELECT 1 FROM source_grants WHERE user_id=$1', [other.user.id])).rowCount,
    0,
  );
  const ownerCookie = cookieOf(await call('sign-in/email', ownerCred));
  reply = await call('delete-user', { callbackURL: origin + '/login' }, ownerCookie);
  assert.ok([200, 403].includes(reply.status));
  assert.equal(mail.filter((m) => m.kind === 'delete' && m.to === ownerCred.email).length, 0);
  assert.equal((await pool.query("SELECT 1 FROM user_access WHERE role='owner'")).rowCount, 1);
  const google = createAccounts({
    pool,
    env: {
      ...env,
      GOOGLE_CLIENT_ID: 'synthetic.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'synthetic',
    },
    sendMail: async () => {},
  });
  const social = await google.handler(
    new Request(origin + '/api/auth/sign-in/social', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'google', callbackURL: origin + '/' }),
    }),
  );
  assert.equal(social.status, 200);
  const authorize = new URL((await social.json()).url);
  assert.equal(authorize.hostname, 'accounts.google.com');
  assert.equal(authorize.searchParams.get('redirect_uri'), origin + '/api/auth/callback/google');
  assert.ok(authorize.searchParams.get('state'));
  console.log(
    'P3 integration passed: invitations, verification, login/reset/logout, deletion, owner bootstrap, user isolation, grants/counts/media, collector revocation and throttling.',
  );
} finally {
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
