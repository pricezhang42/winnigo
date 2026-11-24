import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Private local state (browser profiles, virtualenvs, scratch scripts); never committed.
    '.winnigo/**',
    '.claude/**',
    // Pre-P1 reference files, excluded from the build (legacy/cloudflare/README.md).
    'legacy/**',
  ]),
  {
    rules: {
      // Photos come from the private /api/photos route (cached, already sized) or the source's
      // own address; Next's image optimizer would fetch and re-encode them again.
      '@next/next/no-img-element': 'off',
      // `_name` marks an intentionally unused value; dropping fields with a rest copy is fine.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['components/ui/**/*.{ts,tsx}', 'hooks/use-mobile.ts'],
    rules: {
      // These files are vendored verbatim from shadcn@4.17.0. Keep the
      // registry source intact while applying the stricter rules to Site code.
      '@typescript-eslint/no-unused-vars': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },
]);

export default eslintConfig;
