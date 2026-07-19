'use strict';

// admin-web bootstrap.
//
// Everything below this file is layered the way ADR 003 layers the API: routes fetch and
// redirect, pages and components render, and no renderer performs I/O.

const http = require('node:http');

const { port } = require('./config');
const { createAdminRouter } = require('./http/router');

const server = http.createServer(createAdminRouter());

server.listen(port, '0.0.0.0', () => {
  console.log(`parkingassistant admin-web listening on port ${port}`);
});
