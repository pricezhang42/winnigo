// Security headers for every response (proxy.ts). They are set per request rather than in
// next.config.ts, whose headers are fixed when the image is built, so HTTPS-only headers follow
// the configured origin.
//
// Scripts and styles allow 'unsafe-inline' because Next.js inlines its bootstrap scripts and
// Leaflet sets inline styles; everything is still limited to this origin. Images may come from
// any HTTPS host (OpenStreetMap tiles and place photos linked from their sources), and the only
// frame is Google's official trail map.

/**
 * @param {{ origin: string, dev?: boolean, indexing?: boolean }} options
 * @returns {Record<string, string>}
 */
export function securityHeaders({ origin, dev = false, indexing = false }) {
  const https = origin.startsWith('https:');
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? ' ws: wss:' : ''}`,
    'frame-src https://www.google.com',
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    ...(https ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    ...(indexing ? {} : { 'X-Robots-Tag': 'noindex, nofollow' }),
  };
}
