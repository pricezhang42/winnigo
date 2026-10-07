import { readFile } from 'node:fs/promises';
import { normalizeHikingBatch } from '../lib/social.mjs';

import { publishingConfig } from './publish-config.mjs';
const { origin, headers } = publishingConfig(process.env);
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
normalizeHikingBatch(input);
let photosSaved = 0,
  photosFailed = 0;
for (const item of input.items) {
  if (!item.photoUrls) continue;
  if (!Array.isArray(item.photoUrls) || item.photoUrls.length > 20)
    throw Error('Use up to 20 photos per listing.');
  const saved = [];
  for (const url of [...new Set(item.photoUrls)]) {
    try {
      const source = new URL(url);
      if (
        source.protocol !== 'https:' ||
        !source.hostname.endsWith('.fbcdn.net') ||
        source.port ||
        source.username ||
        source.password
      )
        throw Error('Invalid photo source');
      // Transfer the requested source photo from the collector host; CDN access can differ in Workers.
      const original = await fetch(source, {
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
      if (!original.ok || !original.body) throw Error('Original photo unavailable');
      const reader = original.body.getReader(),
        chunks = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8 * 1024 * 1024) {
          await reader.cancel();
          throw Error('Photo too large');
        }
        chunks.push(value);
      }
      const response = await fetch(origin + '/api/photos/import', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(25000),
        headers: {
          ...headers,
          'Content-Type': 'application/octet-stream',
          'X-Winnigo-Photo-Source': url,
        },
        body: Buffer.concat(chunks),
      });
      if (!response.ok) throw Error('Photo unavailable');
      const photo = await response.json();
      if (!/^\/api\/photos\/[a-f0-9]{64}$/.test(photo.url)) throw Error('Invalid photo response');
      saved.push(photo.url);
      photosSaved++;
    } catch {
      photosFailed++;
    }
  }
  if (saved.length) item.images = saved;
  delete item.photoUrls;
}
if (photosFailed) {
  input.status = 'partial';
  input.message =
    (input.message || '') +
    ` ${photosFailed} photos could not be saved; existing photos were retained.`;
}
const totals = {
  ok: true,
  processed: 0,
  added: 0,
  updated: 0,
  photosSaved,
  photosFailed,
  status: input.status,
};
for (let offset = 0; offset < Math.max(1, input.items.length); offset += 10) {
  const response = await fetch(origin + '/api/sources', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers,
    body: JSON.stringify({
      ...input,
      items: input.items.slice(offset, offset + 10),
      action: 'sync-hiking-manitoba',
    }),
  });
  if (!response.ok) throw Error('Collection upload failed: HTTP ' + response.status);
  const result = await response.json();
  if (result.ok !== true) throw Error('Collection upload did not confirm success.');
  totals.processed += result.processed;
  totals.added += result.added;
  totals.updated += result.updated;
}
console.log(JSON.stringify(totals));
