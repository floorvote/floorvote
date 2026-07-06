import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'

// Type-aware lint for the tenant Worker. Focused on the Workers-specific
// hazards that tsc does not catch — chiefly floating promises (dropped errors
// in queue consumers / waitUntil paths). Tooling (eslint, @typescript-eslint)
// is shared via the root install (same as web/).
export default [
  { ignores: ['dist/**', 'migrations/**', '.wrangler/**'] },
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
