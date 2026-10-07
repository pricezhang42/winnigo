import { loadLocalEnv } from './load-env.mjs';
import { S3Storage } from '../lib/server/s3-storage.mjs';
loadLocalEnv();
console.log(
  JSON.stringify(
    await new S3Storage().cleanup({ apply: process.argv.includes('--apply') }),
    null,
    2,
  ),
);
