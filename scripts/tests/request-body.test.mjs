import test from 'node:test';
import assert from 'node:assert/strict';
import { readLimited } from '../../lib/server/request-body.mjs';

test('bounded body reads combine chunks and release the stream lock', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3]));
      controller.close();
    },
  });
  assert.deepEqual(await readLimited(stream, 3), new Uint8Array([1, 2, 3]));
  assert.equal(stream.locked, false);
  assert.deepEqual(await readLimited(null, 3), new Uint8Array());
});

test('oversized body reads cancel and unlock without returning partial data', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4]));
    },
    cancel() {
      cancelled = true;
    },
  });
  assert.equal(await readLimited(stream, 3), null);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test('failed body reads preserve the error and release the stream lock', async () => {
  const failure = Error('Interrupted stream');
  const stream = new ReadableStream({
    pull(controller) {
      controller.error(failure);
    },
  });
  await assert.rejects(readLimited(stream, 3), (error) => error === failure);
  assert.equal(stream.locked, false);
});
