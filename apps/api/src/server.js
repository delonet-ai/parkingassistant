'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { Pool } = require('pg');

const port = Number(process.env.PORT || 3000);
const startedAt = new Date().toISOString();
const databaseUrl = process.env.DATABASE_URL;

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl
    })
  : null;

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function queryOne(text, params = []) {
  if (!pool) {
    throw new Error('DATABASE_URL is not configured');
  }

  const result = await pool.query(text, params);
  return result.rows[0] || null;
}

async function queryMany(text, params = []) {
  if (!pool) {
    throw new Error('DATABASE_URL is not configured');
  }

  const result = await pool.query(text, params);
  return result.rows;
}

async function handleDbHealth() {
  if (!pool) {
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
    const result = await pool.query('select current_database() as database, now() as server_time, 1 as ok');

    return {
      ok: true,
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        check: 'db',
        database: result.rows[0].database,
        serverTime: result.rows[0].server_time
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
    const sysadmin = await queryOne(
      `
        select
          au.id,
          au.login,
          au.display_name,
          au.status,
          count(aur.id) filter (where ar.code = 'system_admin') as system_admin_role_count
        from auth_users au
        left join auth_user_roles aur on aur.auth_user_id = au.id
        left join auth_roles ar on ar.id = aur.auth_role_id
        where lower(au.login) = 'sysadmin'
        group by au.id, au.login, au.display_name, au.status
      `
    );

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
    const users = await queryMany(
      `
        select
          au.id,
          au.login,
          au.display_name,
          au.status,
          au.last_login_at,
          au.created_at,
          coalesce(
            json_agg(
              json_build_object(
                'code', ar.code,
                'name', ar.name
              )
              order by ar.code
            ) filter (where ar.id is not null),
            '[]'::json
          ) as roles
        from auth_users au
        left join auth_user_roles aur on aur.auth_user_id = au.id
        left join auth_roles ar on ar.id = aur.auth_role_id
        where au.deleted_at is null
        group by au.id, au.login, au.display_name, au.status, au.last_login_at, au.created_at
        order by lower(au.login)
      `
    );

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      service: 'api',
      uptimeSeconds: Math.floor(process.uptime()),
      startedAt,
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health/db') {
    const result = await handleDbHealth();
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/auth/bootstrap-status') {
    const result = await handleAuthBootstrapStatus();
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/admin/users') {
    const result = await handleAdminUsersList();
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    sendJson(res, 200, {
      status: 'ok',
      service: 'api',
      message: 'Parking Assistant API is running',
      endpoints: ['/health', '/health/db', '/auth/bootstrap-status', '/admin/users']
    });
    return;
  }

  sendJson(res, 404, {
    status: 'error',
    error: 'Not found'
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`parkingassistant api listening on port ${port}`);
});

async function shutdown(signal) {
  console.log(`received ${signal}, shutting down`);

  server.close(async () => {
    if (pool) {
      await pool.end();
    }

    process.exit(0);
  });
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
