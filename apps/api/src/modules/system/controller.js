'use strict';

function createSystemController({ services, startedAt }) {
  const service = services.system;

  function handleHealth() {
    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        uptimeSeconds: Math.floor(process.uptime()),
        startedAt,
        timestamp: new Date().toISOString()
      }
    };
  }

  async function handleDbHealth() {
    if (!service.isDatabaseConfigured()) {
      return {
        ok: false,
        statusCode: 500,
        payload: {
          status: 'error',
          service: 'api',
          check: 'db',
          error: 'DATABASE_URL is not configured'
        }
      };
    }

    try {
      const identity = await service.selectDatabaseIdentity();

      return {
        ok: true,
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          check: 'db',
          database: identity.database,
          serverTime: identity.server_time
        }
      };
    } catch (error) {
      return {
        ok: false,
        statusCode: 500,
        payload: {
          status: 'error',
          service: 'api',
          check: 'db',
          error: error.message
        }
      };
    }
  }

  async function handleAuthBootstrapStatus() {
    try {
      const sysadmin = await service.findBootstrapSysadmin();

      return {
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          check: 'auth-bootstrap',
          bootstrapUserExists: Boolean(sysadmin),
          bootstrapUser: sysadmin
            ? {
                id: sysadmin.id,
                login: sysadmin.login,
                displayName: sysadmin.display_name,
                authStatus: sysadmin.status,
                hasSystemAdminRole: Number(sysadmin.system_admin_role_count) > 0
              }
            : null
        }
      };
    } catch (error) {
      return {
        statusCode: 500,
        payload: {
          status: 'error',
          service: 'api',
          check: 'auth-bootstrap',
          error: error.message
        }
      };
    }
  }

  async function handleAdminUsersList() {
    try {
      const users = await service.listAuthUsers();

      return {
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          users: users.map((user) => ({
            id: user.id,
            login: user.login,
            displayName: user.display_name,
            authStatus: user.status,
            lastLoginAt: user.last_login_at,
            createdAt: user.created_at,
            roles: user.roles
          }))
        }
      };
    } catch (error) {
      return {
        statusCode: 500,
        payload: {
          status: 'error',
          service: 'api',
          error: error.message
        }
      };
    }
  }

  return {
    name: 'system',
    routes: [
      { method: 'GET', path: '/health', advertise: true, handler: () => handleHealth() },
      { method: 'GET', path: '/health/db', advertise: true, handler: () => handleDbHealth() },
      { method: 'GET', path: '/auth/bootstrap-status', advertise: true, handler: () => handleAuthBootstrapStatus() },
      { method: 'GET', path: '/admin/users', advertise: true, handler: () => handleAdminUsersList() }
    ]
  };
}

module.exports = {
  createSystemController
};
