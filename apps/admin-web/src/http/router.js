'use strict';

// The request dispatcher.
//
// Route groups are tried in the order the monolithic if/else chain used them, and each
// returns true once it has answered. Nothing else falls through to the 404.

const { handleAssetRoutes } = require('./routes/assets');
const { handlePageRoute } = require('./routes/page');
const { handleFormRoutes } = require('./routes/forms');

const routeGroups = [handleAssetRoutes, handlePageRoute, handleFormRoutes];

function createAdminRouter() {
  return async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    for (const group of routeGroups) {
      if (await group(req, res, url)) {
        return;
      }
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'error', error: 'Not found' }));
  };
}

module.exports = {
  createAdminRouter
};
