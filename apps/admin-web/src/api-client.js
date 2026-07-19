'use strict';

// The only place admin-web talks to the API.
//
// Renderers never fetch: a route handler builds the model with these two functions and
// hands it to a pure renderer, which is what makes every page unit-testable.

const { apiBaseUrl } = require('./config');

async function fetchJson(pathname) {
  const response = await fetch(`${apiBaseUrl}${pathname}`);
  const text = await response.text();

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

async function postJson(pathname, payload) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

module.exports = {
  fetchJson,
  postJson
};
