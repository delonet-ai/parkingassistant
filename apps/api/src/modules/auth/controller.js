'use strict';

const { readJsonBody } = require('../../../../../packages/shared/http');
const { AbortTransaction } = require('../../support/transaction');
const { internalError } = require('../../support/http-errors');
const { MIN_PASSWORD_LENGTH } = require('./service');

function badRequest(error) {
  return {
    statusCode: 400,
    payload: {
      status: 'error',
      service: 'api',
      error
    }
  };
}

function createAuthController({ services }) {
  const service = services.auth;

  async function handleActivate(req) {
    let body;

    try {
      body = await readJsonBody(req);
    } catch {
      return badRequest('Request body must be valid JSON');
    }

    const login = body && typeof body.login === 'string' ? body.login.trim() : '';
    const password = body && typeof body.password === 'string' ? body.password : '';

    if (!login) {
      return badRequest('login is required');
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      return badRequest(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }

    try {
      const user = await service.activate({ login, password });

      return {
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          user: {
            id: user.id,
            login: user.login,
            displayName: user.display_name,
            authStatus: user.status
          }
        }
      };
    } catch (error) {
      if (error instanceof AbortTransaction) {
        return error.result;
      }

      return internalError(error, 'handleActivate');
    }
  }

  // Not advertised: the endpoint index at `GET /` is pinned by a golden snapshot, and the
  // auth routes change who may ask, not what the API offers.
  return {
    name: 'auth',
    routes: [{ method: 'POST', path: '/auth/activate', handler: ({ req }) => handleActivate(req) }]
  };
}

module.exports = {
  createAuthController
};
