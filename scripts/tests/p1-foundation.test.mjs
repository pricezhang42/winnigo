// Configuration and request-origin checks. Storage behaviour is covered by npm run check:p2.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../../lib/server/config.mjs';
const storage = {
  DATABASE_URL: 'postgres://example/test',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_BUCKET: 'test',
  S3_REGION: 'test',
  S3_ACCESS_KEY: 'test',
  S3_SECRET_KEY: 'test',
};
test('P1 config fails closed, needs storage and restricts local mode to loopback', () => {
  const local = { ...storage, WINNIGO_AUTH_MODE: 'local' };
  assert.throws(() => readConfig(storage), /credentials/);
  assert.throws(() => readConfig({ WINNIGO_AUTH_MODE: 'sites' }), /basic, local or session/);
  assert.throws(() => readConfig({ ...local, WINNIGO_HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => readConfig({ ...local, WINNIGO_ORIGIN: 'https://example.com' }), /loopback/);
  assert.throws(() => readConfig({ WINNIGO_AUTH_MODE: 'local' }), /Missing DATABASE_URL/);
  assert.throws(
    () => readConfig({ ...local, WINNIGO_REPOSITORY: 'fixture' }),
    /fixtures were removed/,
  );
  assert.throws(() => readConfig({ ...local, DATABASE_URL: 'mysql://x/y' }), /Invalid database/);
  assert.throws(() => readConfig({ ...local, PORT: 'NaN' }), /PORT/);
  assert.equal(readConfig(local).port, 5173);
  assert.equal(
    readConfig({ ...local, WINNIGO_REPOSITORY: 'postgres', WINNIGO_STORAGE: 's3' }).mode,
    'local',
  );
});

import { sameOrigin } from '../../lib/server/request-origin.mjs';
test('P1 origin checks handle Next internal URLs and reject cross-site and forged forwarding', () => {
  const request = (origin, extra = {}) =>
    new Request('http://localhost:5173/api/sources', {
      headers: { host: '127.0.0.1:5180', origin, ...extra },
    });
  assert.equal(sameOrigin(request('http://127.0.0.1:5180'), 'http://127.0.0.1:5173'), true);
  assert.equal(
    sameOrigin(
      request('https://evil.example', { 'x-forwarded-host': 'evil.example' }),
      'http://127.0.0.1:5173',
    ),
    false,
  );
  assert.equal(sameOrigin(request('null'), 'http://127.0.0.1:5173'), false);
});
