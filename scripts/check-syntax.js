'use strict';

// `npm run check` — parse every JavaScript file in the repo.
//
// This replaces the hand-kept list of `node --check <file>` calls the script used to be.
// That list had to be extended by hand in Tasks 13, 15 and 16, and Task 17 alone adds
// thirty-odd module files; a list that is edited by hand is a list that silently stops
// covering things. Walking the tree covers new files the moment they are written.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'coverage']);

function collectJsFiles(dir) {
  const files = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        files.push(...collectJsFiles(path.join(dir, entry.name)));
      }
    } else if (entry.name.endsWith('.js')) {
      files.push(path.join(dir, entry.name));
    }
  }

  return files;
}

const files = collectJsFiles(repoRoot).sort();
const failures = [];

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failures.push(`${path.relative(repoRoot, file)}\n${error.stderr.toString().trim()}`);
  }
}

if (failures.length) {
  console.error(failures.join('\n\n'));
  console.error(`\ncheck failed: ${failures.length} of ${files.length} files did not parse`);
  process.exit(1);
}

console.log(`check ok: ${files.length} files parsed`);
