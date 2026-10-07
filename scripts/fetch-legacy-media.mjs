// Explicit read-only R2/S3 source export. No source deletion or public ACL changes.
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { contentHash } from '../lib/server/s3-storage.mjs';
const args = process.argv.slice(2),
  file = args.find((a) => !a.startsWith('--'));
if (!file) throw Error('Provide manifest.json [--apply]');
const manifest = JSON.parse(await readFile(file, 'utf8')),
  directory = dirname(resolve(file));
for (const m of manifest.media)
  if (!/^[a-f0-9]{64}$/.test(m.id) || m.file !== 'photos/' + m.id)
    throw Error('Invalid media entry');
if (!args.includes('--apply')) {
  console.log(JSON.stringify({ dryRun: true, objects: manifest.media.length }));
  process.exit(0);
}
for (const key of [
  'LEGACY_S3_ENDPOINT',
  'LEGACY_S3_BUCKET',
  'LEGACY_S3_ACCESS_KEY',
  'LEGACY_S3_SECRET_KEY',
])
  if (!process.env[key]) throw Error(`Missing ${key}`);
const prefix = process.env.LEGACY_S3_PREFIX || 'photos/';
if (!/^[-a-zA-Z0-9/]+\/$/.test(prefix) || prefix.includes('..'))
  throw Error('Invalid legacy prefix');
const client = new S3Client({
  region: 'auto',
  endpoint: process.env.LEGACY_S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.LEGACY_S3_ACCESS_KEY,
    secretAccessKey: process.env.LEGACY_S3_SECRET_KEY,
  },
});
await mkdir(join(directory, 'photos'), { recursive: true, mode: 0o700 });
try {
  for (const m of manifest.media) {
    let bytes;
    try {
      bytes = await readFile(join(directory, m.file));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (!bytes) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: process.env.LEGACY_S3_BUCKET, Key: prefix + m.id }),
      );
      bytes = Buffer.from(await result.Body.transformToByteArray());
      m.contentType = result.ContentType;
    }
    m.contentType ||=
      bytes[0] === 137
        ? 'image/png'
        : bytes[0] === 255
          ? 'image/jpeg'
          : bytes.toString('ascii', 0, 4) === 'RIFF'
            ? 'image/webp'
            : undefined;
    if (contentHash(bytes) !== m.id) throw Error('Legacy media integrity mismatch');
    const path = join(directory, m.file);
    await writeFile(path + '.tmp', bytes, { mode: 0o600 });
    await rename(path + '.tmp', path);
    m.size = bytes.length;
    await writeFile(file + '.tmp', JSON.stringify(manifest), { mode: 0o600 });
    await rename(file + '.tmp', file);
  }
  console.log(JSON.stringify({ exported: manifest.media.length }));
} finally {
  client.destroy();
}
