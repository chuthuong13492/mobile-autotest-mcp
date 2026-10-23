// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      'coverage/**',
      'spikes/**',
      'fixtures/**',
      'docs/**',
      'test/boundaries-negative/**',
      'test/lint-negative/**',
      '.dependency-cruiser.cjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // ADR-0015: dynamic imports must use literal specifiers so dependency rules can see them.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression[source.type!="Literal"]',
          message: 'Dynamic import() must use a string-literal specifier (ADR-0015).',
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
