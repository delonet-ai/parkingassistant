'use strict';

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

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString('utf8').trim();
  if (!rawBody) {
    return {};
  }

  return JSON.parse(rawBody);
}

async function readFormBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

module.exports = {
  readFormBody,
  readJsonBody,
  sendJson
};
