import type { NextConfig } from 'next';
const config: NextConfig = {
  output: 'standalone',
  agentRules: false,
  serverExternalPackages: ['pg-boss', 'jsqr', 'jpeg-js', 'pngjs'],
  poweredByHeader: false,
  logging: { incomingRequests: false }, // Verification/reset URLs contain credentials.
  // Fixture files are seeded at runtime, never embedded in public bundles.
  outputFileTracingExcludes: {
    '*': [
      './.env*',
      './.dev.vars*',
      './.winnigo/**/*',
      './.wrangler/**/*',
      './.sites-runtime/**/*',
      './spikes/**/*',
    ],
  },
};
export default config;
