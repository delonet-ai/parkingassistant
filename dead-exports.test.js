'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Task 18's third checkbox — "confirm no dead exports" — asserted rather than grepped once
// by hand. Dismantling a 7 820-line monolith into 17 modules left behind a handful of names
// that were exported for a caller that no longer exists; nothing but a check that runs on
// every commit keeps that from accumulating again.
//
// Scope and its limits, stated so a future failure is read correctly:
//   - only the `module.exports = { ... }` object form is inspected. A file exporting a
//     function directly has one export and its own require sites prove it.
//   - a name counts as used if it appears as a word anywhere in another file. That is
//     deliberately generous: this test is here to catch what is provably dead, not to
//     litigate every borderline case.

const repoRoot = __dirname;
const ROOTS = ['apps', 'packages', 'scripts'];

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

const files = ROOTS.flatMap((root) => collectJsFiles(path.join(repoRoot, root))).map((file) => ({
  path: file,
  source: fs.readFileSync(file, 'utf8')
}));

const EXPORT_BLOCK = /module\.exports\s*=\s*\{([\s\S]*?)\n\};/;
const EXPORTED_NAME = /^ {2}([A-Za-z_$][\w$]*)[,:]/gm;

function exportedNames(source) {
  const block = source.match(EXPORT_BLOCK);

  return block ? [...block[1].matchAll(EXPORTED_NAME)].map((match) => match[1]) : [];
}

test('no source file exports a name nothing else requires', () => {
  const dead = [];

  for (const file of files) {
    if (file.path.endsWith('.test.js') || file.path.endsWith('.itest.js')) {
      continue;
    }

    for (const name of exportedNames(file.source)) {
      const used = new RegExp(`\\b${name}\\b`);
      const consumers = files.filter((other) => other.path !== file.path && used.test(other.source));

      if (consumers.length === 0) {
        dead.push(`${path.relative(repoRoot, file.path)} exports ${name}`);
      }
    }
  }

  assert.deepEqual(dead, [], `dead exports:\n${dead.join('\n')}`);
});

test('the scan actually found exports to check', () => {
  // Guards the test above against passing vacuously if the walker or the regex breaks.
  const withExports = files.filter((file) => exportedNames(file.source).length > 0);

  assert.ok(withExports.length >= 35, `expected the module tree to be scanned, found ${withExports.length} files`);
});
