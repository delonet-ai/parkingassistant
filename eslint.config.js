'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'infra/**', '**/*.min.js']
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node
      }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error'
    }
  },
  {
    files: ['**/*.test.js'],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  },
  // Dependency-direction boundaries (ADR 003). The project is CommonJS, so
  // `no-restricted-imports` alone would never fire — it only sees `import`
  // declarations. The `no-restricted-syntax` selectors below are the rule that
  // actually bites on `require()`; the import-shaped rule is kept so the boundary
  // still holds if a file ever moves to ESM.
  {
    files: ['packages/domain/**/*.js'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'pg', message: 'domain is pure: no database access. Put the SQL in a repository.js.' },
          { name: 'node:http', message: 'domain is pure: no HTTP. Put request handling in a controller.js.' },
          { name: 'node:https', message: 'domain is pure: no HTTP. Put request handling in a controller.js.' }
        ],
        patterns: [
          {
            group: ['**/shared/http', '**/shared/html'],
            message: 'domain is pure: no HTTP or HTML helpers. Serialize in a controller.js.'
          }
        ]
      }],
      'no-restricted-syntax': ['error',
        {
          selector: 'CallExpression[callee.name="require"][arguments.0.value="pg"]',
          message: 'domain is pure: no database access. Put the SQL in a repository.js.'
        },
        {
          selector: 'CallExpression[callee.name="require"][arguments.0.value=/^node:https?$/]',
          message: 'domain is pure: no HTTP. Put request handling in a controller.js.'
        },
        {
          selector: 'CallExpression[callee.name="require"][arguments.0.value=/shared\\/(http|html)$/]',
          message: 'domain is pure: no HTTP or HTML helpers. Serialize in a controller.js.'
        }
      ]
    }
  },
  {
    files: ['**/controller.js'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'pg', message: 'a controller does no SQL: call a service, which owns the transaction.' }
        ]
      }],
      'no-restricted-syntax': ['error', {
        selector: 'CallExpression[callee.name="require"][arguments.0.value="pg"]',
        message: 'a controller does no SQL: call a service, which owns the transaction.'
      }]
    }
  }
];
