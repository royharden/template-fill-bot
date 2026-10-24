// ESLint flat config (typescript-eslint). Source must stay erasable TypeScript so that
// scripts/syntax-check.mjs (node:module stripTypeScriptTypes, strip mode) can parse it:
// no enum, no namespace, no parameter properties; type-only imports use `import type`.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/', 'dist/', 'coverage/', 'results/cache/'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: 'enum is not erasable; use a union of string literals.' },
        { selector: 'TSModuleDeclaration', message: 'namespace is not erasable; use an ES module.' },
        { selector: 'TSParameterProperty', message: 'parameter properties are not erasable; assign fields explicitly.' },
      ],
    },
  },
);
