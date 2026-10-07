import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
mkdirSync('.winnigo', { recursive: true, mode: 0o700 });
if (!existsSync('.env.local')) {
  // Preserve the owner's explicit local mode and credentials without copying data.
  const old = existsSync('.dev.vars') ? parseEnv(readFileSync('.dev.vars', 'utf8')) : {};
  const secret = () => randomBytes(32).toString('hex');
  const dbPassword = secret();
  const values = {
    BETTER_AUTH_SECRET: secret(),
    WINNIGO_MAIL_MODE: 'file',
    WINNIGO_AUTH_MODE: old.WINNIGO_AUTH_MODE === 'local' ? 'local' : 'session',
    WINNIGO_ADMIN_USER: old.WINNIGO_ADMIN_USER || 'owner',
    WINNIGO_ADMIN_PASSWORD: old.WINNIGO_ADMIN_PASSWORD || secret(),
    WINNIGO_COLLECTOR_KEY: old.WINNIGO_COLLECTOR_KEY || secret(),
    WINNIGO_HOST: '127.0.0.1',
    PORT: '5173',
    WINNIGO_ORIGIN: 'http://127.0.0.1:5173',
    WINNIGO_REPOSITORY: 'postgres',
    WINNIGO_STORAGE: 's3',
    WINNIGO_DATA_DIR: '.winnigo/node',
    WINNIGO_SEED_PROFILE: 'snapshot',
    POSTGRES_PASSWORD: dbPassword,
    DATABASE_URL: `postgres://winnigo:${dbPassword}@127.0.0.1:55433/winnigo`,
    S3_ENDPOINT: 'http://127.0.0.1:58334',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'winnigo-dev',
    S3_ACCESS_KEY: secret(),
    S3_SECRET_KEY: secret(),
  };
  writeFileSync(
    '.env.local',
    Object.entries(values)
      .map(([k, v]) => k + '=' + JSON.stringify(v))
      .join('\n') + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    'Created private .env.local for the Node application. Existing legacy data is unchanged.',
  );
} else console.log('Keeping existing .env.local configuration.');

const current = readFileSync('.env.local', 'utf8');
if (!parseEnv(current).BETTER_AUTH_SECRET)
  writeFileSync(
    '.env.local',
    current + '\nBETTER_AUTH_SECRET=' + JSON.stringify(randomBytes(32).toString('hex')) + '\n',
    { mode: 0o600 },
  );
