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

test('a controller may not reach past its service to a repository', async () => {
  const specifiers = [
    './repository',
    '../places/repository',
    '../../repositories/db',
    '../../services/availability'
  ];

  for (const specifier of specifiers) {
    const messages = await lint(
      'apps/api/src/modules/places/controller.js',
      `'use strict';\nconst reached = require('${specifier}');\nmodule.exports = { reached };\n`
    );

    assert.equal(messagesFor(messages, BOUNDARY_RULES).length, 1, `${specifier} should be restricted`);
  }
});

// Task 18 widened the boundaries from domain+controller to every layer. Each rule below is
// checked by making it fire: a rule that enforces nothing passes a config review silently.

test('a service may not require pg, HTTP, HTML or a controller', async () => {
  const specifiers = [
    'pg',
    'node:http',
    'node:https',
    '../../../../../packages/shared/http',
    '../../../../../packages/shared/html',
    './controller'
  ];

  for (const specifier of specifiers) {
    const messages = await lint(
      'apps/api/src/modules/places/service.js',
      `'use strict';\nconst reached = require('${specifier}');\nmodule.exports = { reached };\n`
    );

    assert.equal(messagesFor(messages, BOUNDARY_RULES).length, 1, `${specifier} should be restricted in a service`);
  }
});

// The one file outside `modules/` that sits at the service layer (availability is a read
// model, not a bounded context — ADR 003). The glob has to name it explicitly, so pin that.
test('the availability read model is held to the service rules', async () => {
  const messages = await lint(
    'apps/api/src/services/availability.js',
    "'use strict';\nconst { Pool } = require('pg');\nmodule.exports = { Pool };\n"
  );

  assert.equal(messagesFor(messages, BOUNDARY_RULES).length, 1);
});

test('a service may require any context repository, the domain and the transaction helper', async () => {
  const messages = await lint(
    'apps/api/src/modules/places/service.js',
    "'use strict';\n" +
      "const repository = require('./repository');\n" +
      "const other = require('../place-releases/repository');\n" +
      "const domain = require('../../../../../packages/domain');\n" +
      "const { withTransaction } = require('../../repositories/db');\n" +
      'module.exports = { repository, other, domain, withTransaction };\n'
  );

  assert.deepEqual(messagesFor(messages, BOUNDARY_RULES), []);
});

test('a repository may not require HTTP, HTML, a service or a controller', async () => {
  const specifiers = [
    'node:http',
    'node:https',
    '../../../../../packages/shared/http',
    '../../../../../packages/shared/html',
    './service',
    './controller'
  ];

  for (const specifier of specifiers) {
    const messages = await lint(
      'apps/api/src/modules/places/repository.js',
      `'use strict';\nconst reached = require('${specifier}');\nmodule.exports = { reached };\n`
    );

    assert.equal(messagesFor(messages, BOUNDARY_RULES).length, 1, `${specifier} should be restricted in a repository`);
  }
});

test('a repository is still free to require pg and the domain', async () => {
  const messages = await lint(
    'apps/api/src/modules/places/repository.js',
    "'use strict';\nconst pg = require('pg');\nconst domain = require('../../../../../packages/domain');\nmodule.exports = { pg, domain };\n"
  );

  assert.deepEqual(messagesFor(messages, BOUNDARY_RULES), []);
});

test('domain may not require an application or the db package', async () => {
  const specifiers = ['../../apps/api/src/modules/places/repository', '../db/migrate'];

  for (const specifier of specifiers) {
    const messages = await lint(
      'packages/domain/rules.js',
      `'use strict';\nconst reached = require('${specifier}');\nmodule.exports = { reached };\n`
    );

    assert.equal(messagesFor(messages, BOUNDARY_RULES).length, 1, `${specifier} should be restricted in domain`);
  }
});

test('shared is a leaf: no pg, no application', async () => {
  for (const specifier of ['pg', '../../apps/api/src/server']) {
    const messages = await lint(
      'packages/shared/dates.js',
      `'use strict';\nconst reached = require('${specifier}');\nmodule.exports = { reached };\n`
    );

    assert.equal(messagesFor(messages, BOUNDARY_RULES).length, 1, `${specifier} should be restricted in shared`);
  }
});

// The synthetic tests above prove the rules fire. This one proves the real tree obeys them,
// so `npm test` fails on a violation even if nobody runs `npm run lint`.
test('every real source file in the repo satisfies the dependency-direction boundaries', async () => {
  const eslint = new ESLint({ cwd: repoRoot });
  const results = await eslint.lintFiles(['apps', 'packages', 'scripts']);

  const violations = results.flatMap((result) =>
    messagesFor(result.messages, BOUNDARY_RULES).map(
      (message) => `${path.relative(repoRoot, result.filePath)}:${message.line} ${message.message}`
    )
  );

  assert.deepEqual(violations, [], `boundary violations:\n${violations.join('\n')}`);
  assert.ok(results.length > 100, `expected the whole tree to be linted, got ${results.length} files`);
});

// The two checks Task 18 asks for by name, done by reading the real files rather than by
// trusting ESLint alone. They overlap with the config on purpose: the config catches a new
// `require`, this catches SQL pasted inline, which no import rule can see.

function collectJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.name === 'node_modules') {
      continue;
    } else if (entry.isDirectory()) {
      collectJsFiles(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }

  return out;
}

// A statement-shaped keyword at the start of a line, which is how every query in this repo
// is written inside a template literal. Matching line starts rather than the bare word keeps
// `updated_at`, `selected` and prose in comments out of it.
const SQL_STATEMENT = /^\s*(select\s|insert\s+into\s|update\s+\w|delete\s+from\s)/im;

test('no controller contains raw SQL', () => {
  const controllers = collectJsFiles(path.join(repoRoot, 'apps')).filter(
    (file) => path.basename(file) === 'controller.js'
  );

  assert.ok(controllers.length >= 15, `expected the module controllers to exist, found ${controllers.length}`);

  const offenders = controllers
    .filter((file) => SQL_STATEMENT.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(repoRoot, file));

  assert.deepEqual(offenders, [], `SQL in a controller: ${offenders.join(', ')}`);
});

test('no domain module imports pg, http, HTML helpers or an application, and holds no SQL', () => {
  const domainFiles = collectJsFiles(path.join(repoRoot, 'packages/domain')).filter(
    (file) => !file.endsWith('.test.js')
  );

  assert.ok(domainFiles.length >= 6, `expected the domain modules to exist, found ${domainFiles.length}`);

  const forbiddenRequire = /require\('(?:pg|node:https?|[^']*shared\/(?:http|html)|[^']*(?:^|\/)(?:apps|db)\/[^']*)'\)/;
  const offenders = [];

  for (const file of domainFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(repoRoot, file);

    if (forbiddenRequire.test(source)) {
      offenders.push(`${relative}: forbidden require`);
    }

    if (SQL_STATEMENT.test(source)) {
      offenders.push(`${relative}: SQL`);
    }
  }

  assert.deepEqual(offenders, [], `domain is not pure: ${offenders.join(', ')}`);
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
    'jobs',
    'system'
  ];

  for (const context of contexts) {
    assert.ok(adr.includes(`\`${context}\``), `ADR 003 is missing context ${context}`);
    assert.ok(architecture.includes(`\`${context}\``), `ARCHITECTURE.md is missing context ${context}`);
  }
});
