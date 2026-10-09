'use strict';

// Cookie I/O for the session (ADR: Task 2 of the auth plan). Two functions, no dependency:
// the request header is parsed by the router and by `/auth/me`, and the response header is
// built by the login and logout handlers.
//
// The stand is plain HTTP, so `Secure` cannot be set — it would make the browser drop the
// cookie and nobody could sign in. `HttpOnly` and `SameSite=Lax` are set, and the missing
// `Secure` is a property of the deployment, not of this code: behind TLS it should be added.

// The one name the session travels under. It lives here rather than in the auth service
// because two layers need it: the auth controller builds the `set-cookie`, and the router's
// guard reads the request header on every request — and the router must not have to import a
// bounded context to learn how to find a session.
const SESSION_COOKIE_NAME = 'pa_session';

// `decodeURIComponent` throws on a dangling percent escape, and the header is whatever the
// client sent. An undecodable value is handed back raw: it will simply not match any stored
// session hash, which is the right answer for a tampered cookie.
function decodeValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// `cookie` is a single header of `name=value` pairs separated by `; `. A malformed pair is
// skipped rather than thrown on — the header is client-controlled and must not be able to
// turn a request into a 500.
function parseCookies(header) {
  const cookies = {};

  if (typeof header !== 'string' || header.length === 0) {
    return cookies;
  }

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');

    if (separator <= 0) {
      continue;
    }

    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (!name || Object.prototype.hasOwnProperty.call(cookies, name)) {
      // First occurrence wins: a second `pa_session=` appended by a client must not be able
      // to override the one the browser is actually holding.
      continue;
    }

    cookies[name] = decodeValue(value);
  }

  return cookies;
}

function readCookie(header, name) {
  const value = parseCookies(header)[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function serializeCookie(name, value, { maxAge, path = '/', httpOnly = true, sameSite = 'Lax' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`];

  if (typeof maxAge === 'number') {
    parts.push(`Max-Age=${Math.max(0, Math.trunc(maxAge))}`);
  }

  if (sameSite) {
    parts.push(`SameSite=${sameSite}`);
  }

  if (httpOnly) {
    parts.push('HttpOnly');
  }

  return parts.join('; ');
}

module.exports = {
  SESSION_COOKIE_NAME,
  parseCookies,
  readCookie,
  serializeCookie
};
