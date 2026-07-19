'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { ESLint } = require('eslint');

// Pins the dependency-direction boundaries from ADR 003 by actually running ESLint over
// synthetic sources at the paths the rules target. Asserting the config object alone
// would not catch the trap this project sits in: `no-restricted-imports` never fires on
// CommonJS `require()`, so a config that *looks* right can enforce nothing.

const repoRoot = __dirname;

async function lint(relativePath, code) {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(code, {
    filePath: path.join(repoRoot, relativePath),
    warnIgnored: false
  });

  return result ? result.messages : [];
}

function messagesFor(messages, ruleIds) {
  return messages.filter((message) => ruleIds.includes(message.ruleId));
}

const BOUNDARY_RULES = ['no-restricted-imports', 'no-restricted-syntax'];

test('domain may not require pg', async () => {
  const messages = await lint('packages/domain/rules.js', "'use strict';\nconst pg = require('pg');\nmodule.exports = { pg };\n");

  assert.equal(messagesFor(messages, BOUNDARY_RULES).length, 1);
  assert.match(messagesFor(messages, BOUNDARY_RULES)[0].message, /repository\.js/);
});

test('domain may not require node:http or node:https', async () => {
  for (const module of ['node:http', 'node:https']) {
    const messages = await lint(
      'packages/domain/rules.js',
      `'use strict';\nconst http = require('${module}');\nmodule.exports = { http };\n`
    );

    assert.equal(messagesFor(messages, BOUNDARY_RULES).length, 1, `${module} should be restricted`);
  }
});

test('domain may not require the shared http/html helpers, at any relative depth', async () => {
  const specifiers = [
    '../shared/http',
    '../../packages/shared/html',
    '../shared/html'
  ];

  for (const specifier of specifiers) {
    const messages = await lint(
      'packages/domain/places/rules.js',
      `'use strict';\nconst helper = require('${specifier}');\nmodule.exports = { helper };\n`
    );

    assert.equal(messagesFor(messages, BOUNDARY_RULES).length, 1, `${specifier} should be restricted`);
  }
});

test('domain may require the node standard library and other domain modules', async () => {
  const messages = await lint(
    'packages/domain/places/rules.js',
    "'use strict';\nconst assert = require('node:assert');\nconst dates = require('../../shared/dates');\nmodule.exports = { assert, dates };\n"
  );

  assert.deepEqual(messagesFor(messages, BOUNDARY_RULES), []);
});

test('a controller may not require pg', async () => {
  const messages = await lint(
    'apps/api/src/modules/places/controller.js',
    "'use strict';\nconst { Pool } = require('pg');\nmodule.exports = { Pool };\n"
  );

  assert.equal(messagesFor(messages, BOUNDARY_RULES).length, 1);
  assert.match(messagesFor(messages, BOUNDARY_RULES)[0].message, /service/);
});

test('a controller may require its service and the shared http helpers', async () => {
  const messages = await lint(
    'apps/api/src/modules/places/controller.js',
    "'use strict';\nconst service = require('./service');\nconst http = require('../../../../../packages/shared/http');\nmodule.exports = { service, http };\n"
  );

  assert.deepEqual(messagesFor(messages, BOUNDARY_RULES), []);
});

test('a service and a repository are still free to require pg', async () => {
  for (const file of ['apps/api/src/modules/places/service.js', 'apps/api/src/modules/places/repository.js']) {
    const messages = await lint(file, "'use strict';\nconst pg = require('pg');\nmodule.exports = { pg };\n");

    assert.deepEqual(messagesFor(messages, BOUNDARY_RULES), [], `${file} should be unrestricted`);
  }
});

test('the bounded contexts in ADR 003 match the module map in ARCHITECTURE.md', () => {
  const adr = fs.readFileSync(path.join(repoRoot, 'docs/adr/003-modular-architecture.md'), 'utf8');
  const architecture = fs.readFileSync(path.join(repoRoot, 'docs/ARCHITECTURE.md'), 'utf8');

  const contexts = [
    'employees',
    'places',
    'place-lines',
    'permanent-assignments',
    'place-releases',
    'employee-requests',
    'guest-requests',
    'reservations',
    'queue',
    'line-occupancy',
    'departure-plans',
    'conflicts',
    'contact-access',
    'maps',
    'dashboard',
    'audit',
    'jobs'
  ];

  for (const context of contexts) {
    assert.ok(adr.includes(`\`${context}\``), `ADR 003 is missing context ${context}`);
    assert.ok(architecture.includes(`\`${context}\``), `ARCHITECTURE.md is missing context ${context}`);
  }
});
