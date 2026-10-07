import test from 'node:test';
import assert from 'node:assert/strict';
import { accessClause, isAdmin } from '../../lib/server/access.mjs';
import { readConfig } from '../../lib/server/config.mjs';
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
  assert.equal(isAdmin({ role: 'user' }), false);
  assert.equal(isAdmin({ role: 'admin' }), true);
});
test('P3 session mode requires durable storage, a secret and HTTPS off loopback', () => {
  assert.throws(() => readConfig({ WINNIGO_AUTH_MODE: 'session' }), /PostgreSQL/);
  const env = {
    WINNIGO_AUTH_MODE: 'session',
    WINNIGO_REPOSITORY: 'postgres',
    WINNIGO_STORAGE: 's3',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    DATABASE_URL: 'postgres://example/test',
    S3_ENDPOINT: 'https://s3.example',
    S3_BUCKET: 'test',
    S3_REGION: 'test',
    S3_ACCESS_KEY: 'test',
    S3_SECRET_KEY: 'test',
    WINNIGO_ORIGIN: 'http://example.com',
  };
  assert.throws(() => readConfig(env), /HTTPS/);
  assert.equal(readConfig({ ...env, WINNIGO_ORIGIN: 'https://example.com' }).mode, 'session');
});
