'use strict';

const { PayloadTooLargeError } = require('./multipart');

// `413` closes the connection, and that is not politeness: it is the one status answered
// *before* the request body has been read, so the bytes still in flight would be parsed as the
// next request on a keep-alive connection — the client then hangs waiting for an answer to a
// request the server never saw.
function sendJson(res, statusCode, payload) {
  const headers = { 'content-type': 'application/json; charset=utf-8' };

  if (statusCode === 413) {
    headers.connection = 'close';
  }

  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(payload));
}

// How much of a request body these readers will hold.
//
// Not a tidiness limit. Both of them accumulate every chunk and then build a string from the
// lot, so without a bound the only ceiling is Node's maximum string length — half a gigabyte of
// resident memory per request, and `/auth/login` and `/auth/activate` are `public: true`, so a
// client that has not signed in can ask for it. A handful of concurrent requests is then enough
// to take the API down, with no valid credentials and no valid JSON.
//
// A megabyte against bodies that are a few hundred bytes: the largest this API takes is a
// handful of identifiers and a comment. The one endpoint that reads a file does not come
// through here — it calls `readRawBody` with its own, far larger limit.
const BODY_LIMIT_BYTES = 1024 * 1024;

async function readBody(req, limitBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;

    // Refused as the bytes arrive, not after: a body counted once it is already in memory is
    // not a body that was bounded.
    if (total > limitBytes) {
      throw new PayloadTooLargeError(limitBytes);
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function readJsonBody(req, limitBytes = BODY_LIMIT_BYTES) {
  const rawBody = (await readBody(req, limitBytes)).toString('utf8').trim();

  if (!rawBody) {
    return {};
  }

  return JSON.parse(rawBody);
}

async function readFormBody(req, limitBytes = BODY_LIMIT_BYTES) {
  return new URLSearchParams((await readBody(req, limitBytes)).toString('utf8'));
}

module.exports = {
  BODY_LIMIT_BYTES,
  // Re-exported so a controller that tells "too large" apart from "not JSON" imports the type
  // from the module whose reader threw it. One class, not a second: a controller comparing a
  // `PayloadTooLargeError` from here against the one `multipart.js` exports gets the same
  // identity, because this is that export.
  PayloadTooLargeError,
  readFormBody,
  readJsonBody,
  sendJson
};
