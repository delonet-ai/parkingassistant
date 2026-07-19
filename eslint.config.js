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
  // Dependency-direction boundaries (ADR 003), enforced on every layer of the tree:
  //
  //   controller → service → repository,  any layer → domain
  //
  // The project is CommonJS, so `no-restricted-imports` alone would never fire — it only
  // sees `import` declarations. The `no-restricted-syntax` selectors below are the rule
  // that actually bites on `require()`; the import-shaped rule is kept alongside so the
  // boundary still holds if a file ever moves to ESM.
  //
  // Each entry names the layer it constrains and only forbids what points the wrong way.
  // Reaching *down* or *sideways* within the allowed direction is deliberately unrestricted
  // — a service may require any context's repository, because a transaction spans contexts.
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
          },
          {
            group: ['**/apps/**', '**/db/**'],
            message: 'domain sits below the applications: it may not require an app or the db package.'
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
        },
        {
          selector: 'CallExpression[callee.name="require"][arguments.0.value=/(^|\\/)(apps|(packages\\/)?db)\\//]',
          message: 'domain sits below the applications: it may not require an app or the db package.'
        }
      ]
    }
  },
  // `packages/shared` is a leaf: format helpers, HTTP/HTML primitives, error shapes. It may
  // not know about the database or reach up into an application.
  {
    files: ['packages/shared/**/*.js'],
    ignores: ['**/*.test.js'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'pg', message: 'shared is a leaf: no database access.' }
        ],
        patterns: [
          { group: ['**/apps/**'], message: 'shared is a leaf: it may not require an application.' }
        ]
      }],
      'no-restricted-syntax': ['error',
        {
          selector: 'CallExpression[callee.name="require"][arguments.0.value="pg"]',
          message: 'shared is a leaf: no database access.'
        },
        {
          selector: 'CallExpression[callee.name="require"][arguments.0.value=/(^|\\/)apps\\//]',
          message: 'shared is a leaf: it may not require an application.'
        }
      ]
    }
  },
  // A controller is HTTP I/O only. It may not reach past its service to a repository, the
  // pg driver, the transaction runner, or the availability read model.
  {
    files: ['**/controller.js'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'pg', message: 'a controller does no SQL: call a service, which owns the transaction.' }
        ],
        patterns: [
          {
            group: ['**/repository', '**/repositories/db', '**/services/availability'],
            message: 'a controller may not reach past its service: call the service, which owns the repository and the transaction.'
          }
        ]
      }],
      'no-restricted-syntax': ['error',
        {
          selector: 'CallExpression[callee.name="require"][arguments.0.value="pg"]',
          message: 'a controller does no SQL: call a service, which owns the transaction.'
        },
        {
          selector: 'CallExpression[callee.name="require"][arguments.0.value=/(repository|repositories\\/db|services\\/availability)$/]',
          message: 'a controller may not reach past its service: call the service, which owns the repository and the transaction.'
        }
      ]
    }
  },
  // A service orchestrates a use case and owns the transaction. It talks to repositories and
  // the domain — never to HTTP, HTML, a controller, or the pg driver directly (transactions
  // go through `withTransaction` in repositories/db.js).
  {
    files: ['**/service.js', 'apps/api/src/services/*.js'],
    ignores: ['**/*.test.js'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'pg', message: 'a service does not open connections: use withTransaction from repositories/db.js.' },
          { name: 'node:http', message: 'a service is transport-agnostic: HTTP belongs in a controller.js.' },
          { name: 'node:https', message: 'a service is transport-agnostic: HTTP belongs in a controller.js.' }
        ],
        patterns: [
          {
            group: ['**/shared/http', '**/shared/html'],
            message: 'a service is transport-agnostic: parse and serialize in a controller.js.'
          },
          { group: ['**/controller'], message: 'dependencies point one way: a service may not require a controller.' }
        ]
      }],
      'no-restricted-syntax': ['error',
        {
          selector: 'CallExpression[callee.name="require"][arguments.0.value="pg"]',
          message: 'a service does not open connections: use withTransaction from repositories/db.js.'
        },
        {
          selector: 'CallExpression[callee.name="require"][arguments.0.value=/^node:https?$/]',
          message: 'a service is transport-agnostic: HTTP belongs in a controller.js.'
        },
        {
          selector: 'CallExpression[callee.name="require"][arguments.0.value=/shared\\/(http|html)$/]',
          message: 'a service is transport-agnostic: parse and serialize in a controller.js.'
        },
        {
          selector: 'CallExpression[callee.name="require"][arguments.0.value=/controller$/]',
          message: 'dependencies point one way: a service may not require a controller.'
        }
      ]
    }
  },
  // A repository is the bottom of the stack: SQL and nothing else. It may not know about
  // HTTP, HTML, or the layers above it.
  {
    files: ['**/repository.js'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'node:http', message: 'a repository is SQL only: no HTTP.' },
          { name: 'node:https', message: 'a repository is SQL only: no HTTP.' }
        ],
        patterns: [
          { group: ['**/shared/http', '**/shared/html'], message: 'a repository is SQL only: no HTTP or HTML helpers.' },
          {
            group: ['**/controller', '**/service'],
            message: 'dependencies point one way: a repository may not require a service or a controller.'
          }
        ]
      }],
      'no-restricted-syntax': ['error',
        {
          selector: 'CallExpression[callee.name="require"][arguments.0.value=/^node:https?$/]',
          message: 'a repository is SQL only: no HTTP.'
        },
        {
          selector: 'CallExpression[callee.name="require"][arguments.0.value=/shared\\/(http|html)$/]',
          message: 'a repository is SQL only: no HTTP or HTML helpers.'
        },
        {
          selector: 'CallExpression[callee.name="require"][arguments.0.value=/(controller|service)$/]',
          message: 'dependencies point one way: a repository may not require a service or a controller.'
        }
      ]
    }
  }
];
