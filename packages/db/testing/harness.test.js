'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  connectionStringForSchema,
  readSqlDirectory,
  stripPsqlMetaCommands
} = require('./harness');

describe('integration harness helpers', () => {
  it('strips psql meta-commands the wire protocol cannot execute', () => {
    const sql = stripPsqlMetaCommands('\\set ON_ERROR_STOP on\nBEGIN;\nselect 1;\nCOMMIT;\n');

    assert.equal(sql.includes('ON_ERROR_STOP'), false);
    assert.ok(sql.includes('select 1;'));
  });

  it('keeps SQL lines that merely contain a backslash', () => {
    const sql = stripPsqlMetaCommands("select 'a\\b' as value;");

    assert.ok(sql.includes("select 'a\\b' as value;"));
  });

  it('points the connection string at the scratch schema', () => {
    const url = connectionStringForSchema('postgresql://u:p@localhost:5432/parking', 'itest_1_1');

    assert.ok(url.includes('options=-c+search_path%3Ditest_1_1%2Cpublic'));
    assert.ok(url.startsWith('postgresql://u:p@localhost:5432/parking?'));
  });

  it('reads schema migrations in lexical order', () => {
    const files = readSqlDirectory(require('node:path').join(__dirname, '..', 'schema'));

    assert.ok(files.length >= 3);
    assert.equal(files[0].name, '001_initial_schema.sql');
    assert.deepEqual(
      files.map((file) => file.name),
      [...files.map((file) => file.name)].sort()
    );
  });

  it('returns an empty list for a directory that does not exist', () => {
    assert.deepEqual(readSqlDirectory('/nonexistent/sql/dir'), []);
  });
});
