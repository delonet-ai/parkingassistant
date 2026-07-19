'use strict';

const { URL } = require('node:url');
const { errorPayload } = require('../../../packages/shared/errors');

// The router owns no routes of its own. Each module publishes a route table and the router
// composes them in the order `modules/index.js` lists the contexts; the endpoint index
// served at `GET /` is derived from the same tables, so a route and its documentation
// cannot drift apart the way the hand-kept `rootEndpoints` array could.
//
// A route entry is:
//   { method, path | paths[] | pattern, handler, advertise? }
//
// `handler` receives one object: { req, url, searchParams, params }. Every route is
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

function createApiRouter({ modules, sendJson }) {
  const table = buildRouteTable(modules);

  async function dispatch(route, context, res) {
    try {
      const result = await route.handler(context);
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
      const context = {
        req,
        url,
        searchParams: url.searchParams,
        params: matched.params,
        pathname: url.pathname
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
