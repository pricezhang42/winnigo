import { NextResponse, type NextRequest } from 'next/server';
import { readConfig } from './lib/server/config.mjs';
import { authenticationRequired } from './lib/auth-policy.mjs';
import { principalFromHeaders } from './lib/server/principal.mjs';
import { securityHeaders } from './lib/security-headers.mjs';
// Read-only routes a visitor may reach when public browsing is enabled (docs/31). The routes
// themselves give visitors public discoveries only.
const PUBLIC_READS = [
  /^\/$/,
  /^\/api\/listings$/,
  /^\/api\/listings\/[^/]+$/,
  /^\/api\/listings\/[^/]+\/availability$/,
  /^\/api\/photos\/[a-f0-9]{64}$/,
  /^\/(?:trail-map-data\.json|[a-z]+\.svg)$/,
];

const pass = () => NextResponse.next();

/**
 * Access gate in front of every page and API route. Anything without a principal is refused,
 * except the health check, the login/reset shell in session mode, public reads when public
 * browsing is enabled, and the import routes (which authenticate collector tokens themselves).
 * Routes still check roles and content access.
 */
export async function proxy(request: NextRequest) {
  const config = readConfig();
  const response = await gate(request, config);
  // Security headers, and no indexing until the owner enables it (WINNIGO_INDEXING).
  const headers = securityHeaders({
    origin: config.origin,
    dev: process.env.NODE_ENV !== 'production',
    indexing: config.indexing,
  });
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

async function gate(request: NextRequest, config: ReturnType<typeof readConfig>) {
  const path = request.nextUrl.pathname;
  if (path === '/api/health' || path === '/robots.txt') return NextResponse.next();
  if (
    config.publicBrowsing &&
    ['GET', 'HEAD'].includes(request.method) &&
    PUBLIC_READS.some((pattern) => pattern.test(path))
  )
    return pass();
  // Only the authentication shell and its static assets are public in session mode.
  if (
    config.mode === 'session' &&
    (path === '/login' ||
      path === '/privacy' ||
      path === '/terms' ||
      path === '/account/reset' ||
      path.startsWith('/api/auth/') ||
      path.startsWith('/_next/') ||
      ['/favicon.ico', '/favicon.svg'].includes(path))
  )
    return pass();
  // Import routes authenticate their service credentials and source scope themselves.
  if (request.method === 'POST' && ['/api/sources', '/api/photos/import'].includes(path))
    return NextResponse.next();
  try {
    if (await principalFromHeaders(request.headers)) return pass();
  } catch {
    return new NextResponse('Authentication unavailable', { status: 503 });
  }
  if (config.mode !== 'session') return authenticationRequired();
  if (path.startsWith('/api/'))
    return NextResponse.json(
      { error: 'Sign in required' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  return NextResponse.redirect(new URL('/login', request.url));
}
