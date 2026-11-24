import type { MetadataRoute } from 'next';
import { readConfig } from '@/lib/server/config.mjs';

// Read per request: indexing is switched on in the server's environment (WINNIGO_INDEXING).
export const dynamic = 'force-dynamic';

/** Crawlers may read public discoveries once indexing is enabled; nothing before that. */
export default function robots(): MetadataRoute.Robots {
  const { indexing, origin } = readConfig();
  return indexing
    ? {
        rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/admin', '/account'] },
        host: origin,
      }
    : { rules: { userAgent: '*', disallow: '/' } };
}
