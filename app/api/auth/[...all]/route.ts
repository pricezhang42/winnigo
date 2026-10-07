import { accounts } from '@/lib/server/accounts.mjs';
import { readConfig } from '@/lib/server/config.mjs';
import { rateLimit } from '@/lib/server/access.mjs';
export const dynamic = 'force-dynamic';
async function handle(request: Request) {
  if (readConfig().mode !== 'session')
    return new Response('Account login is enabled in session mode', { status: 404 });
  try {
    if (!(await rateLimit('auth:global', 120)))
      return new Response('Try again later', { status: 429, headers: { 'Retry-After': '60' } });
    if (request.method === 'POST') {
      if (request.headers.get('origin') !== readConfig().origin)
        return new Response('Invalid origin', { status: 403 });
      if (!request.headers.get('content-type')?.startsWith('application/json'))
        return new Response('JSON required', { status: 415 });
      const reader = request.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader)
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 16384) {
            await reader.cancel();
            return new Response('Request too large', { status: 413 });
          }
          chunks.push(value);
        }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      let body;
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return new Response('Invalid JSON', { status: 400 });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return new Response('JSON object required', { status: 400 });
      if (
        typeof body.email === 'string' &&
        !(await rateLimit('auth:email:' + body.email.toLowerCase(), 10, 300))
      )
        return new Response('Try again later', { status: 429 });
      request = new Request(request.url, { method: 'POST', headers: request.headers, body: bytes });
    }
    const response = await accounts().handler(request);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch {
    return new Response('Account service temporarily unavailable', {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
export const GET = handle;
export const POST = handle;
