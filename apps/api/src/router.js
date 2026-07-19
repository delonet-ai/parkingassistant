'use strict';

const { URL } = require('node:url');
const { errorPayload } = require('../../../packages/shared/errors');

// The router owns no routes of its own. Each module publishes a route table and the router
// composes them in the order `modules/index.js` lists the contexts; the endpoint index
// served at `GET /` is derived from the same tables, so a route and its documentation
// cannot drift apart the way the hand-kept `rootEndpoints` array could.
//
// A route entry is:
//   { method, path | paths[] | pattern, handler, advertise?, safe? }
//
// `handler` receives one object: { req, url, searchParams, params }. `safe: true` selects
// the catch-all dispatcher (a thrown error becomes a 500 payload); without it a throw
// propagates, which is what the pre-split router did for the write endpoints.
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
    const result = await route.handler(context);
    sendJson(res, result.statusCode, result.payload);
  }

  async function dispatchSafely(route, context, res) {
    try {
      await dispatch(route, context, res);
    } catch (error) {
      sendJson(res, 500, errorPayload(error));
    }
  }

  return async function routeApiRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const matched = findRoute(table, req.method, url.pathname);

    if (matched) {
      const context = {
        req,
        url,
        searchParams: url.searchParams,
        params: matched.params,
        pathname: url.pathname
      };

      if (matched.route.safe) {
        await dispatchSafely(matched.route, context, res);
      } else {
        await dispatch(matched.route, context, res);
      }

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
