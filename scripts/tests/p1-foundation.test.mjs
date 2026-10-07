import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureRepository } from '../../lib/server/fixture-repository.mjs';
import { FixtureStorage } from '../../lib/server/fixture-storage.mjs';
import { readConfig } from '../../lib/server/config.mjs';
import { applyAction } from '../../lib/server/actions.mjs';
const fixture = JSON.parse(
  await readFile(new URL('../fixtures/p0-discovery.json', import.meta.url), 'utf8'),
);
test('P1 config fails closed and restricts local mode to loopback', () => {
  assert.throws(() => readConfig({}), /credentials/);
  assert.throws(() => readConfig({ WINNIGO_AUTH_MODE: 'sites' }), /basic, local or session/);
  assert.throws(
    () => readConfig({ WINNIGO_AUTH_MODE: 'local', WINNIGO_HOST: '0.0.0.0' }),
    /loopback/,
  );
  assert.throws(
    () => readConfig({ WINNIGO_AUTH_MODE: 'local', WINNIGO_ORIGIN: 'https://example.com' }),
    /loopback/,
  );
  assert.throws(
    () => readConfig({ WINNIGO_AUTH_MODE: 'local', WINNIGO_REPOSITORY: 'postgres' }),
    /together/,
  );
  assert.throws(() => readConfig({ WINNIGO_AUTH_MODE: 'local', PORT: 'NaN' }), /PORT/);
  assert.equal(readConfig({ WINNIGO_AUTH_MODE: 'local' }).port, 5173);
});
test('P1 fixture writes serialize, survive reopening, and roll back failed mutations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'winnigo-repository-'));
  try {
    const repo = new FixtureRepository(dir);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        new FixtureRepository(dir).transaction((s) => {
          s.sources.push({ id: String(i) });
        }),
      ),
    );
    assert.equal((await repo.read()).sources.length, 8);
    await assert.rejects(
      repo.transaction((s) => {
        s.sources = [];
        throw Error('rollback');
      }),
      /rollback/,
    );
    assert.equal((await new FixtureRepository(dir).read()).sources.length, 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('P1 repeated collector imports retain photo order, comments, hidden state and corrections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'winnigo-import-'));
  try {
    const repo = new FixtureRepository(dir);
    const batch = { action: 'sync-hiking-manitoba', status: 'ok', items: [fixture.community] };
    assert.equal((await applyAction(batch, repo)).added, 1);
    const id = (await repo.read()).listings[0].id;
    await applyAction({ action: 'update', id, hidden: true, title: 'Owner correction' }, repo);
    assert.equal((await applyAction(batch, repo)).added, 0);
    const { listings } = await repo.read();
    assert.equal(listings.length, 1);
    assert.equal(listings[0].hidden, true);
    assert.equal(listings[0].override.title, 'Owner correction');
    assert.deepEqual(listings[0].payload.images, fixture.community.images);
    assert.equal(listings[0].payload.commentNotes.length, 1);
    await assert.rejects(applyAction({ ...batch, status: 'blocked' }, repo));
    assert.equal((await repo.read()).listings.length, 1);
    await assert.rejects(applyAction({ action: 'refresh' }, repo), /unavailable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('P1 photo adapter supports read/write/delete without accepting traversal keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'winnigo-media-'));
  try {
    const store = new FixtureStorage(dir),
      id = 'a'.repeat(64);
    assert.equal(await store.get(id), null);
    await store.put(id, Buffer.from('fixture'), 'image/png');
    assert.equal((await store.get(id)).bytes.toString(), 'fixture');
    await assert.rejects(store.get('../private'));
    await store.delete(id);
    assert.equal(await store.get(id), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
