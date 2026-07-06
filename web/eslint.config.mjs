import reactHooks from 'eslint-plugin-react-hooks'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'

export default [
  {
    ignores: ['src/components/tiptap-*/**', 'src/hooks/use-throttled-callback.ts', 'src/hooks/use-unmount.ts', 'src/lib/tiptap-utils.ts'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: './tsconfig.json' },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/]",
          message: 'Use a design token from src/styles/tokens.ts instead of a raw hex color.',
        },
        {
          selector: "Property[key.name=/^(borderRadius|fontSize|fontWeight)$/] > Literal[raw=/^[0-9]+$/]",
          message: 'Use a design token from src/styles/tokens.ts (radius/fontSize/fontWeight) instead of a raw number.',
        },
      ],
    },
  },
  {
    // Intentional hex-literal exemptions — each entry has a specific reason:
    //   tokens.ts          — token source of truth; raw hex is the definition, not a usage
    //   tiptap-ui/**       — editor color palette; product data controlled by the Tiptap package
    //   *.test.*           — tests assert literal rendered values, not token references
    files: [
      'src/styles/tokens.ts',
      'src/components/tiptap-ui/**/*.{ts,tsx}',
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
    rules: { 'no-restricted-syntax': 'off' },
  },
]
