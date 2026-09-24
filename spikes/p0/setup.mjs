import {randomBytes} from 'node:crypto';
import {writeFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const target = fileURLToPath(new URL('.env', import.meta.url));
if (!existsSync(target)) {
  const secret = () => randomBytes(32).toString('hex');
  const password = secret();
  writeFileSync(target, `P0_DB_PASSWORD=${password}\nDATABASE_URL=postgres://p0:${password}@127.0.0.1:55432/winnigo_p0\nP0_S3_KEY=${secret()}\nP0_S3_SECRET=${secret()}\nP0_AUTH_SECRET=${secret()}\n`, {mode: 0o600, flag: 'wx'});
}
console.log('Isolated P0 credentials ready; values are not printed.');
