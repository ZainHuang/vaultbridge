import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config(js.configs.recommended, ts.configs.recommended, {
  files: ['src/**/*.ts', 'tests/**/*.ts'],
  rules: {
    'no-control-regex': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
}, {
  files: ['src/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', { patterns: ['node:*', 'fs', 'path', 'crypto', 'child_process', 'simple-git'] }],
    'no-restricted-globals': ['error', 'Buffer', 'process', 'require'],
  },
});
