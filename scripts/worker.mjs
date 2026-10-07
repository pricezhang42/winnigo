import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadLocalEnv } from './load-env.mjs';
import { readConfig } from '../lib/server/config.mjs';
import { getRepository } from '../lib/server/adapters.mjs';
loadLocalEnv();
const config = readConfig();
await getRepository().health();
console.log(
  'Winnigo worker ready. Collection schedules and job consumers are not enabled until P5.',
);
if (!process.argv.includes('--once')) {
  const file = join(config.dataDir, 'worker-heartbeat');
  await mkdir(config.dataDir, { recursive: true });
  const heartbeat = () => writeFile(file, String(Date.now()), { mode: 0o600 });
  await heartbeat();
  const timer = setInterval(
    () =>
      heartbeat().catch(() => {
        console.error('Worker heartbeat failed');
        process.exit(1);
      }),
    15000,
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      clearInterval(timer);
      process.exit(0);
    });
}
