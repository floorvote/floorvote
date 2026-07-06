import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'

// Type-aware lint for the central Worker. Focused on the Workers-specific
// hazards that tsc does not catch — chiefly floating promises (dropped errors
// in ingestor consumers / cron waitUntil paths). Tooling (eslint,
// @typescript-eslint) is shared via the root install (central is standalone, so
// its own lockfile is intentionally not modified for dev-only lint tooling).
export default [
  { ignores: ['dist/**', 'migrations/**', 'migrations-legiscan/**', '.wrangler/**', 'web/**'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: './tsconfig.json' },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
]
