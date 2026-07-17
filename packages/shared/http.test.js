'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readFormBody, readJsonBody, sendJson } = require('./http');

function createMockRes() {
  return {
    headers: null,
    statusCode: null,
    body: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(payload) {
      this.body = payload;
    }
  };
}

function requestFrom(text) {
  return (async function* () {
    if (text.length > 0) {
      yield Buffer.from(text, 'utf8');
    }
  })();
}

test('sendJson writes status, json content-type, and serialized payload', () => {
  const res = createMockRes();
  sendJson(res, 201, { ok: true, count: 3 });

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.headers, {
    'content-type': 'application/json; charset=utf-8'
  });
  assert.equal(res.body, '{"ok":true,"count":3}');
});

test('readJsonBody parses a JSON body from streamed chunks', async () => {
  const body = await readJsonBody(requestFrom('  {"name":"Место"}  '));
  assert.deepEqual(body, { name: 'Место' });
});

test('readJsonBody returns an empty object for an empty body', async () => {
  assert.deepEqual(await readJsonBody(requestFrom('')), {});
  assert.deepEqual(await readJsonBody(requestFrom('   ')), {});
});

test('readJsonBody throws on invalid JSON', async () => {
  await assert.rejects(() => readJsonBody(requestFrom('{not json')), SyntaxError);
});

test('readFormBody parses urlencoded form fields', async () => {
  const params = await readFormBody(requestFrom('a=1&b=two&b=three'));
  assert.equal(params.get('a'), '1');
  assert.deepEqual(params.getAll('b'), ['two', 'three']);
});

test('readFormBody decodes percent-encoded values', async () => {
  const params = await readFormBody(requestFrom('name=%D0%9C%D0%B5%D1%81%D1%82%D0%BE'));
  assert.equal(params.get('name'), 'Место');
});

test('readFormBody returns empty params for an empty body', async () => {
  const params = await readFormBody(requestFrom(''));
  assert.equal([...params].length, 0);
});
