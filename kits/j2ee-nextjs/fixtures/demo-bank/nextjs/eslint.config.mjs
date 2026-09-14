// Minimal flat config: typescript-eslint recommended plus a few house rules.
// Deliberately no framework plugin zoo — the hard gates are typecheck, lint,
// test, build; the house style lives in CONTRIBUTING.md and the exemplars.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/', '.next/', 'out/', 'next-env.d.ts'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'never' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      'prefer-const': 'error',
    },
  },
);
