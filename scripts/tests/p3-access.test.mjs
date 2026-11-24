import test from 'node:test';
import assert from 'node:assert/strict';
import { accessClause, isAdmin } from '../../lib/server/access.mjs';
import { readConfig } from '../../lib/server/config.mjs';
import { passwordProblem } from '../../lib/password-policy.mjs';
test('P3 authorization fails closed and distinguishes admin from private-content owner', () => {
  const binds = [];
  const bind = (v) => {
    binds.push(v);
    return '$' + binds.length;
  };
  assert.equal(accessClause(null, bind), 'false');
  assert.equal(accessClause({ role: 'owner' }, bind), 'true');
  const sql = accessClause({ role: 'admin', userId: "user' OR true --" }, bind);
  assert.ok(sql.includes('source_grants'));
  assert.ok(!sql.includes("user'"));
  assert.deepEqual(binds, ["user' OR true --"]);
  // A visitor (public browsing, docs/31) reads public rows only, never through grants.
  assert.equal(accessClause({ role: 'visitor' }, bind, 'e'), "e.visibility = 'public'");
  assert.equal(isAdmin({ role: 'visitor' }), false);
  assert.equal(isAdmin({ role: 'user' }), false);
  assert.equal(isAdmin({ role: 'admin' }), true);
});
test('P3 session mode requires storage, a secret and HTTPS off loopback', () => {
  assert.throws(() => readConfig({ WINNIGO_AUTH_MODE: 'session' }), /Missing DATABASE_URL/);
  const env = {
    WINNIGO_AUTH_MODE: 'session',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    DATABASE_URL: 'postgres://example/test',
    S3_ENDPOINT: 'https://s3.example',
    S3_BUCKET: 'test',
    S3_REGION: 'test',
    S3_ACCESS_KEY: 'test',
    S3_SECRET_KEY: 'test',
    WINNIGO_ORIGIN: 'http://example.com',
  };
  assert.throws(() => readConfig({ ...env, BETTER_AUTH_SECRET: 'short' }), /BETTER_AUTH_SECRET/);
  assert.throws(() => readConfig(env), /HTTPS/);
  assert.equal(readConfig({ ...env, WINNIGO_ORIGIN: 'https://example.com' }).mode, 'session');
});

test('public browsing is opt-in and needs session mode', () => {
  const env = {
    WINNIGO_AUTH_MODE: 'session',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    DATABASE_URL: 'postgres://example/test',
    S3_ENDPOINT: 'https://s3.example',
    S3_BUCKET: 'test',
    S3_REGION: 'test',
    S3_ACCESS_KEY: 'test',
    S3_SECRET_KEY: 'test',
    WINNIGO_ORIGIN: 'https://example.com',
  };
  assert.equal(readConfig(env).publicBrowsing, false);
  assert.equal(readConfig({ ...env, WINNIGO_PUBLIC_BROWSING: 'enabled' }).publicBrowsing, true);
  assert.throws(
    () => readConfig({ ...env, WINNIGO_PUBLIC_BROWSING: 'yes' }),
    /enabled or disabled/,
  );
  const basic = {
    ...env,
    WINNIGO_AUTH_MODE: 'basic',
    WINNIGO_ADMIN_USER: 'o',
    WINNIGO_ADMIN_PASSWORD: 'p',
  };
  assert.throws(() => readConfig({ ...basic, WINNIGO_PUBLIC_BROWSING: 'enabled' }), /session mode/);
  const local = { ...env, WINNIGO_AUTH_MODE: 'local', WINNIGO_ORIGIN: 'http://127.0.0.1:5173' };
  assert.equal(readConfig({ ...local, WINNIGO_PUBLIC_BROWSING: 'enabled' }).publicBrowsing, false);
});

test('sign-up is invitation-only unless deliberately opened', () => {
  const env = {
    WINNIGO_AUTH_MODE: 'local',
    DATABASE_URL: 'postgres://example/test',
    S3_ENDPOINT: 'https://s3.example',
    S3_BUCKET: 'test',
    S3_REGION: 'test',
    S3_ACCESS_KEY: 'test',
    S3_SECRET_KEY: 'test',
  };
  assert.equal(readConfig(env).signup, 'invitation');
  assert.equal(readConfig({ ...env, WINNIGO_SIGNUP: 'open' }).signup, 'open');
  assert.throws(() => readConfig({ ...env, WINNIGO_SIGNUP: 'everyone' }), /invitation or open/);
});

test('passwords need 8 characters with both letters and numbers', () => {
  for (const ok of ['abcd1234', 'Winnipeg2026', 'été2026x'])
    assert.equal(passwordProblem(ok), null, ok);
  assert.match(passwordProblem('Ab1'), /8 characters/);
  for (const weak of ['abcdefgh', '12345678', '!!!!????'])
    assert.match(passwordProblem(weak), /letters and numbers/, weak);
  assert.match(passwordProblem('a1'.repeat(65)), /at most/);
});
