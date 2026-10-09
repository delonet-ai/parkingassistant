'use strict';

// The integration suites' cookie jar.
//
// Since Task 3 every route but `/health`, `/health/db`, `/auth/*` and the index at `GET /`
// requires a session, so practically every request a suite makes has to carry one. Threading
// a cookie through the ~200 `postJson`/`getJson` call sites would state the same fact 200
// times and would make every future test remember it; instead `startApi` registers the cookie
// it obtained against the base URL it is listening on, and the request helpers look it up.
// The suites already address an API by its base URL, so the base URL is the natural key, and
// a suite that boots two APIs gets two independent sessions without saying anything.
//
// A suite that wants an *anonymous* request passes `{ cookie: null }` to the helper — that is
// how the 401 paths are asserted. Passing an explicit string sends that cookie instead, which
// is how a second operator's session is exercised.

const cookiesByBaseUrl = new Map();

function rememberSessionCookie(baseUrl, cookie) {
  if (typeof cookie === 'string' && cookie.length > 0) {
    cookiesByBaseUrl.set(baseUrl, cookie);
  } else {
    cookiesByBaseUrl.delete(baseUrl);
  }
}

function forgetSessionCookie(baseUrl) {
  cookiesByBaseUrl.delete(baseUrl);
}

/**
 * Headers for one request against `baseUrl`.
 *
 * `cookie` is tri-state on purpose: absent means "whatever the jar holds", `null` means
 * "send none", a string means "send this one".
 */
function sessionHeaders(baseUrl, options = {}) {
  const cookie = Object.prototype.hasOwnProperty.call(options, 'cookie')
    ? options.cookie
    : cookiesByBaseUrl.get(baseUrl) || null;

  return typeof cookie === 'string' && cookie.length > 0 ? { cookie } : {};
}

module.exports = {
  forgetSessionCookie,
  rememberSessionCookie,
  sessionHeaders
};
