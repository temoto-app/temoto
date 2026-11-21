import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'spikes/**', '*.config.ts', '.claude/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' }
      ]
    }
  },
  {
    // shared/ is where the types shared by main / renderer / gateway live, so
    // `any` is banned there (IMPLEMENTATION_BRIEF chapter 7).
    files: ['src/shared/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'error' }
  },
  {
    files: ['scripts/**/*.mjs', 'test/**/*.ts'],
    languageOptions: {
      // `performance` is a Node global (scripts/bench/*.mjs use it for measurement).
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        performance: 'readonly'
      }
    },
    rules: { '@typescript-eslint/no-explicit-any': 'off' }
  }
)
