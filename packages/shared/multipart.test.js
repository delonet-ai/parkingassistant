'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const {
  MultipartFormatError,
  PayloadTooLargeError,
  parseMultipartFormData,
  readRawBody
} = require('./multipart');

const BOUNDARY = '----pa-test-boundary';

/** Builds a body the way a browser does: CRLF everywhere, a closing delimiter with `--`. */
function buildBody(parts, boundary = BOUNDARY) {
  const chunks = [];

  for (const part of parts) {
    const disposition = part.filename
      ? `form-data; name="${part.name}"; filename="${part.filename}"`
      : `form-data; name="${part.name}"`;
    const headers = [`Content-Disposition: ${disposition}`];

    if (part.contentType) {
      headers.push(`Content-Type: ${part.contentType}`);
    }

    chunks.push(Buffer.from(`--${boundary}\r\n${headers.join('\r\n')}\r\n\r\n`, 'utf8'));
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value, 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return Buffer.concat(chunks);
}

test('fields and files are separated by the presence of a filename', () => {
  const body = buildBody([
    { name: 'mapCode', value: 'g4' },
    { name: 'mapTitle', value: 'G4' },
    { name: 'mapFile', filename: 'plan.png', contentType: 'image/png', value: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }
  ]);

  const form = parseMultipartFormData(`multipart/form-data; boundary=${BOUNDARY}`, body);

  assert.equal(form.fields.get('mapCode'), 'g4');
  assert.equal(form.fields.get('mapTitle'), 'G4');
  assert.equal(form.fields.has('mapFile'), false);

  const file = form.files.get('mapFile');
  assert.equal(file.filename, 'plan.png');
  assert.equal(file.contentType, 'image/png');
  assert.deepEqual([...file.buffer], [0x89, 0x50, 0x4e, 0x47]);
});

test('a binary file survives the round trip byte for byte', () => {
  // Every byte value, including the CRLF pair and the ones no text encoding round-trips:
  // the parser reads the body as latin1 to cut it up, and must not re-encode the content.
  const payload = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  const body = buildBody([{ name: 'mapFile', filename: 'plan.bin', value: payload }]);

  const form = parseMultipartFormData(`multipart/form-data; boundary="${BOUNDARY}"`, body);

  assert.deepEqual([...form.files.get('mapFile').buffer], [...payload]);
});

test('a utf-8 filename is decoded as utf-8', () => {
  // The name is stored with every imported place and in the audit row, so it must arrive intact.
  const body = buildBody([{ name: 'catalogFile', filename: 'Каталог мест.xlsx', value: Buffer.from('x') }]);

  const form = parseMultipartFormData(`multipart/form-data; boundary=${BOUNDARY}`, body);

  assert.equal(form.files.get('catalogFile').filename, 'Каталог мест.xlsx');
});

test('a utf-8 field is decoded as utf-8', () => {
  const body = buildBody([{ name: 'mapTitle', value: 'Этаж G4 — подложка' }]);

  const form = parseMultipartFormData(`multipart/form-data; boundary=${BOUNDARY}`, body);

  assert.equal(form.fields.get('mapTitle'), 'Этаж G4 — подложка');
});

test('a quoted boundary and a trailing parameter are both accepted', () => {
  const body = buildBody([{ name: 'mapCode', value: 'g3' }]);

  assert.equal(
    parseMultipartFormData(`multipart/form-data; boundary="${BOUNDARY}"; charset=utf-8`, body)
      .fields.get('mapCode'),
    'g3'
  );
});

test('a missing boundary is refused rather than parsed as empty', () => {
  // The type, not the sentence: the catalog upload maps these two errors to different status
  // codes, so a reworded message must not be able to move a 413 to a 400.
  for (const contentType of ['multipart/form-data', '', undefined]) {
    assert.throws(() => parseMultipartFormData(contentType, Buffer.alloc(0)), (error) => {
      assert.ok(error instanceof MultipartFormatError);
      assert.match(error.message, /boundary is missing/);
      return true;
    });
  }
});

test('a part without a name, and one without headers, are skipped', () => {
  const body = Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data\r\n\r\nnameless\r\n`, 'utf8'),
    Buffer.from(`--${BOUNDARY}\r\nno headers here\r\n`, 'utf8'),
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="mapCode"\r\n\r\ng5\r\n`, 'utf8'),
    Buffer.from(`--${BOUNDARY}--\r\n`, 'utf8')
  ]);

  const form = parseMultipartFormData(`multipart/form-data; boundary=${BOUNDARY}`, body);

  assert.deepEqual([...form.fields.keys()], ['mapCode']);
  assert.equal(form.files.size, 0);
});

test('readRawBody concatenates the stream', async () => {
  const body = await readRawBody(Readable.from([Buffer.from('ab'), Buffer.from('cd')]));

  assert.equal(body.toString('utf8'), 'abcd');
});

test('readRawBody refuses a body over the limit instead of buffering it', async () => {
  await assert.rejects(readRawBody(Readable.from([Buffer.alloc(8), Buffer.alloc(8)]), 10), (error) => {
    assert.ok(error instanceof PayloadTooLargeError);
    assert.ok(!(error instanceof MultipartFormatError), 'the two faults must stay distinguishable');
    assert.equal(error.limitBytes, 10);
    return true;
  });
});

test('the ESM admin UI server sees both named exports', async () => {
  // apps/admin-ui is `type: module` and imports this CommonJS file by name. Node finds those
  // names by lexing the file, so a refactor of the export shape would break the UI server
  // without touching a single `require`.
  const imported = await import('./multipart.js');

  assert.equal(typeof imported.parseMultipartFormData, 'function');
  assert.equal(typeof imported.readRawBody, 'function');
  assert.equal(typeof imported.PayloadTooLargeError, 'function');
  assert.equal(typeof imported.MultipartFormatError, 'function');
});
