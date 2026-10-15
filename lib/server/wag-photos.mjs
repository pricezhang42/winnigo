// Original photo bytes only. Session credentials stay in memory and never reach stored listings.
import { spawn } from 'node:child_process';
import { readLimited } from './request-body.mjs';
const LIMIT = 8 * 1024 * 1024;

export function wagPhotoUrl(value) {
  const url = new URL(value);
  if (
    url.origin !== 'https://www.wag.ca' ||
    url.username ||
    url.password ||
    !/^\/isl\/uploads\/.+\.(?:jpe?g|png|webp)$/i.test(url.pathname)
  )
    throw Error('Refused non-WAG photo URL');
  return url.href;
}

// The browser's clearance can depend on its network context. On a host worker, optionally
// download inside the existing FlareSolverr container. No shell, mounts or container changes.
const DOWNLOAD = `import json,sys,requests,signal
signal.alarm(18)
p=json.load(sys.stdin)
r=requests.get(p['url'],headers=p['headers'],timeout=15,stream=True,allow_redirects=False)
if r.status_code != 200: sys.exit(2)
data=bytearray()
for chunk in r.iter_content(65536):
 data.extend(chunk)
 if len(data)>8388608: sys.exit(3)
sys.stdout.buffer.write(data)
`;
function inContainer(container, request, signal) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container))
    throw Error('Invalid WAG photo container name');
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', container, 'python', '-c', DOWNLOAD], {
      stdio: ['pipe', 'pipe', 'ignore'],
      signal,
    });
    const chunks = [];
    let size = 0;
    child.on('error', () => reject(Error('WAG photo container unavailable')));
    child.stdin.on('error', () => {});
    child.stdout.on('data', (bytes) => {
      size += bytes.length;
      if (size > LIMIT) child.kill();
      else chunks.push(bytes);
    });
    child.on('close', (code) =>
      code === 0 && size <= LIMIT
        ? resolve(Buffer.concat(chunks))
        : reject(Error('WAG photo download failed')),
    );
    child.stdin.end(JSON.stringify(request));
  });
}

export async function fetchWagPhoto(
  value,
  session,
  { container = process.env.WINNIGO_WAG_PHOTO_CONTAINER, signal, fetchImpl = fetch } = {},
) {
  const url = wagPhotoUrl(value);
  const headers = {
    'User-Agent': session.userAgent,
    Referer: session.url,
    Cookie: (session.cookies || [])
      .filter((c) => ['www.wag.ca', '.wag.ca', 'wag.ca'].includes(c.domain))
      .map((c) => c.name + '=' + c.value)
      .join('; '),
  };
  signal = AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
  let bytes;
  if (container) bytes = await inContainer(container, { url, headers }, signal);
  else {
    const response = await fetchImpl(url, { headers, redirect: 'error', signal });
    if (!response.ok) throw Error('WAG photo returned HTTP ' + response.status);
    bytes = await readLimited(response.body, LIMIT);
  }
  if (!bytes?.length) throw Error('Empty or oversized WAG photo');
  const buffer = Buffer.from(bytes);
  const contentType =
    buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      ? 'image/jpeg'
      : buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? 'image/png'
        : buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP'
          ? 'image/webp'
          : null;
  if (!contentType) throw Error('WAG photo is not a supported image');
  return { bytes: buffer, contentType };
}
