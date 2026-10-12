'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const http = require('node:http');

const { BODY_LIMIT_BYTES, PayloadTooLargeError, readFormBody, readJsonBody, sendJson } = require('./http');

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

/** A body streamed in chunks, so the limit is met before the whole of it exists. */
function requestOf(bytes, chunkSize = 64 * 1024) {
  return (async function* () {
    for (let sent = 0; sent < bytes; sent += chunkSize) {
      yield Buffer.alloc(Math.min(chunkSize, bytes - sent), 0x20);
    }
  })();
}

test('readJsonBody refuses a body past the limit instead of holding it', async () => {
  // Chunks counted on the way in: the generator below would yield 4 MB, and the reader has to
  // stop before it has them all. Asserted on the type, which is what tells a controller to
  // answer 413 rather than "must be valid JSON".
  await assert.rejects(() => readJsonBody(requestOf(4 * 1024 * 1024)), PayloadTooLargeError);
  await assert.rejects(() => readJsonBody(requestOf(32), 16), PayloadTooLargeError);

  // The limit itself is not refused, and the default leaves room for every body this API takes.
  const body = JSON.stringify({ comment: 'x'.repeat(2048) });
  assert.deepEqual(await readJsonBody(requestFrom(body)), JSON.parse(body));
  assert.ok(BODY_LIMIT_BYTES >= 64 * 1024);
});

test('readFormBody refuses a body past the limit', async () => {
  await assert.rejects(() => readFormBody(requestOf(32), 16), PayloadTooLargeError);
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

test('a 413 closes the connection, because the request body was never read', async () => {
  const server = http.createServer((req, res) => {
    sendJson(res, 413, { status: 'error', error: 'Request body is too large' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, {
      method: 'POST',
      body: 'x'
    });

    assert.equal(response.status, 413);
    assert.equal(response.headers.get('connection'), 'close');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
