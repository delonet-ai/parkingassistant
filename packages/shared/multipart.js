'use strict';

// Multipart parsing: the admin UI's floor-plan upload and the API's catalog upload both read a
// request body through this, so it lives in `shared` rather than beside either of them.
//
// Behaviour is unchanged from the copy that sat in `apps/admin-ui/multipart.js`; only the module
// system differs. `apps/admin-ui` is the one ESM package in the repo, and its `import { … }` of
// this CommonJS file keeps working through Node's named-export detection — which finds the names
// only because the export below is a literal object of plain identifiers. Spelling it as
// `exports.readRawBody = …`, or assembling the object at runtime, would leave the UI server
// importing `undefined` and failing on the first upload rather than at startup.
//
// Dependency-free on purpose: so is every process that calls it.

/**
 * A request body past the caller's limit.
 *
 * A type, not a message: the catalog upload answers 413 for this and 400 for a malformed form,
 * and telling them apart by comparing prose would turn "too large" into "malformed" the first
 * time someone reworded the sentence.
 */
class PayloadTooLargeError extends Error {
  constructor(limitBytes) {
    super('Request body is too large');
    this.name = 'PayloadTooLargeError';
    this.limitBytes = limitBytes;
  }
}

/** A body that is not `multipart/form-data`, or whose boundary is missing. */
class MultipartFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MultipartFormatError';
  }
}

async function readRawBody(req, limitBytes = 15 * 1024 * 1024) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) {
      throw new PayloadTooLargeError(limitBytes);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function parseMultipartFormData(contentType, body) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];

  if (!boundary) {
    throw new MultipartFormatError('Multipart boundary is missing');
  }

  const delimiter = `--${boundary}`;
  const parts = body.toString('binary').split(delimiter).slice(1, -1);
  const fields = new Map();
  const files = new Map();

  for (const rawPart of parts) {
    const trimmed = rawPart.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const headerEnd = trimmed.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      continue;
    }

    const rawHeaders = trimmed.slice(0, headerEnd);
    const rawContent = trimmed.slice(headerEnd + 4);
    const headers = new Map(
      rawHeaders.split('\r\n').map((line) => {
        const separator = line.indexOf(':');
        return [line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()];
      })
    );
    const disposition = headers.get('content-disposition') || '';
    const name = /name="([^"]+)"/.exec(disposition)?.[1];
    // The body was read as latin1 to keep file bytes intact; browsers send the filename
    // itself as UTF-8, so it is re-read as such — otherwise a Cyrillic name lands garbled.
    const rawFilename = /filename="([^"]*)"/.exec(disposition)?.[1];
    const filename = rawFilename && Buffer.from(rawFilename, 'binary').toString('utf8');

    if (!name) {
      continue;
    }

    const content = Buffer.from(rawContent, 'binary');
    if (filename) {
      files.set(name, {
        filename,
        contentType: headers.get('content-type') || 'application/octet-stream',
        buffer: content
      });
    } else {
      fields.set(name, content.toString('utf8'));
    }
  }

  return { fields, files };
}

module.exports = { MultipartFormatError, PayloadTooLargeError, parseMultipartFormData, readRawBody };
