'use strict';

const { URL } = require('node:url');
const { errorPayload } = require('../../../packages/shared/errors');
const { SESSION_COOKIE_NAME, readCookie } = require('./support/cookies');

// Deny by default. A route is closed unless its table entry says `public: true`, so a route
// added later without a thought about access control is closed rather than open — the
// direction a mistake has to fall. `apps/api/src/route-access.test.js` enumerates the
// composed table and fails if the set of public routes is anything but the four kinds below
// (`/health`, `/health/db`, `/auth/*` and the derived index at `GET /`), which is what makes
// this a rule rather than an intention.
//
// `roles` narrows a closed route further: a session whose roles do not intersect it answers
// 403. An empty or absent `roles` means "any signed-in operator", which with the two roles
// the seed defines (`system_admin`, `parking_admin`) is every `/admin/*` route but the
// user-management ones.
const AUTHENTICATION_REQUIRED = 'Authentication required';
const ROLE_REQUIRED = 'Your role does not allow this action';

// The router owns no routes of its own. Each module publishes a route table and the router
// composes them in the order `modules/index.js` lists the contexts; the endpoint index
// served at `GET /` is derived from the same tables, so a route and its documentation
// cannot drift apart the way the hand-kept `rootEndpoints` array could.
//
// A route entry is:
//   { method, path | paths[] | pattern, handler, advertise?, public?, roles? }
//
// `handler` receives one object: { req, url, searchParams, params, authUser, roles, session }
// and returns { statusCode, payload, headers? }. Every route is
// dispatched through the same catch: a handler that throws answers 500 and the process
// stays up. `safe` is gone — it used to mean "this route catches", which left the write
// endpoints letting a rejection escape the request listener into an unhandled rejection,
// i.e. a malformed uuid in a POST body took the API down. See docs/plans, Task 21.
function buildRouteTable(modules) {
  const exactRoutes = new Map();
  const patternRoutes = [];
  const endpoints = [];

  function advertise(path) {
    if (!endpoints.includes(path)) {
      endpoints.push(path);
    }
  }

  for (const module of modules) {
    for (const route of module.routes) {
      const paths = route.pattern ? [] : [].concat(route.path || route.paths);

      for (const path of paths) {
        exactRoutes.set(`${route.method} ${path}`, route);
      }

      if (route.pattern) {
        patternRoutes.push(route);
      }

      if (route.advertise === true) {
        paths.forEach(advertise);
      } else if (typeof route.advertise === 'string') {
        advertise(route.advertise);
      }
    }
  }

  return { endpoints, exactRoutes, patternRoutes };
}

function findRoute({ exactRoutes, patternRoutes }, method, pathname) {
  const exact = exactRoutes.get(`${method} ${pathname}`);

  if (exact) {
    return { route: exact, params: [] };
  }

  for (const route of patternRoutes) {
    if (route.method !== method) {
      continue;
    }

    const match = pathname.match(route.pattern);

    if (match) {
      return { route, params: match.slice(1) };
    }
  }

  return null;
}

// 403, never 404. Hiding the route from an operator who is signed in but holds the wrong
// role would turn "you may not do this" into "this does not exist", and the operator would
// report a broken UI instead of a missing role.
function accessRefusal(route, resolved) {
  if (!resolved) {
    return { statusCode: 401, error: AUTHENTICATION_REQUIRED };
  }

  const required = route.roles;

  if (Array.isArray(required) && required.length > 0 && !required.some((role) => resolved.roles.includes(role))) {
    return { statusCode: 403, error: ROLE_REQUIRED };
  }

  return null;
}

function createApiRouter({ modules, sendJson, resolveSession }) {
  // Not optional, and not defaulted to something permissive: a router built without a way to
  // resolve a session could only either refuse everything or allow everything, and the second
  // is the one a wiring mistake would silently produce.
  if (typeof resolveSession !== 'function') {
    throw new TypeError('createApiRouter requires a resolveSession function');
  }

  const table = buildRouteTable(modules);

  // Resolved once per request and handed to the handler, so a service that needs to name the
  // actor does not have to re-read the cookie. A public route resolves nobody and does not
  // touch the database: `/health` has to answer while the pool is down.
  async function authorize(route, req, res) {
    if (route.public === true) {
      return { allowed: true, resolved: null };
    }

    let resolved;

    try {
      resolved = await resolveSession(readCookie(req.headers.cookie, SESSION_COOKIE_NAME));
    } catch (error) {
      console.error('session resolution failed', error);
      sendJson(res, 500, errorPayload('Internal server error'));
      return { allowed: false };
    }

    const refusal = accessRefusal(route, resolved);

    if (refusal) {
      sendJson(res, refusal.statusCode, errorPayload(refusal.error, refusal.statusCode));
      return { allowed: false };
    }

    return { allowed: true, resolved };
  }

  async function dispatch(route, context, res) {
    try {
      const result = await route.handler(context);

      // A handler may return `headers` alongside its payload; `set-cookie` on login and
      // logout is the only use so far. They are set before `sendJson`, whose `writeHead`
      // merges them with the content type rather than replacing them.
      if (result.headers) {
        for (const [name, value] of Object.entries(result.headers)) {
          res.setHeader(name, value);
        }
      }

      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      // The real error goes to the log, never to the client: an unmapped failure is a
      // driver or programming error, and its message quotes the input that caused it.
      console.error(`unhandled error in ${route.method} ${context.pathname}`, error);
      sendJson(res, 500, errorPayload('Internal server error'));
    }
  }

  return async function routeApiRequest(req, res) {
    let url;

    try {
      // A fixed base on purpose. This used to interpolate `req.headers.host`, which the
      // client controls: `Host: ]bad host[` made `new URL` throw before any route matched,
      // and the rejection escaped the request listener — one header, no valid path or body
      // needed, and the API was down. Nothing downstream reads the host, only pathname and
      // searchParams, so there is no reason to let the client into the parse at all.
      url = new URL(req.url, 'http://api.local');
    } catch {
      sendJson(res, 400, errorPayload('Malformed request URL', 400));
      return;
    }

    const matched = findRoute(table, req.method, url.pathname);

    if (matched) {
      const access = await authorize(matched.route, req, res);

      if (!access.allowed) {
        return;
      }

      const context = {
        req,
        url,
        searchParams: url.searchParams,
        params: matched.params,
        pathname: url.pathname,
        authUser: access.resolved ? access.resolved.authUser : null,
        roles: access.resolved ? access.resolved.roles : [],
        session: access.resolved ? access.resolved.session : null
      };

      await dispatch(matched.route, context, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      sendJson(res, 200, {
        status: 'ok',
        service: 'api',
        message: 'Parking Assistant API is running',
        endpoints: table.endpoints
      });
      return;
    }

    sendJson(res, 404, errorPayload('Not found', 404));
  };
}

module.exports = {
  buildRouteTable,
  createApiRouter
};
