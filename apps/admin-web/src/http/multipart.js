'use strict';

// Multipart parsing for the one upload the admin UI has: the per-floor plan background.

async function readRawBody(req, limitBytes = 15 * 1024 * 1024) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) {
      throw new Error('Request body is too large');
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function parseMultipartFormData(contentType, body) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];

  if (!boundary) {
    throw new Error('Multipart boundary is missing');
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
    const filename = /filename="([^"]*)"/.exec(disposition)?.[1];

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

module.exports = {
  parseMultipartFormData,
  readRawBody
};
