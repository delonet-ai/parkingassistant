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

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString('utf8').trim();
  if (!rawBody) {
    return {};
  }

  return JSON.parse(rawBody);
}

function isIsoDate(value) {
  return typeof value === 'string' && isoDatePattern.test(value);
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

async function handleAdminPlacesList() {
  try {
    const places = await queryMany(
      `
        select
          pp.id,
          pp.code,
          pp.title,
          pp.floor_label,
          pp.place_type,
          pp.guest_priority_rank,
          pp.is_active,
          u.id as owner_user_id,
          u.display_name as owner_display_name,
          u.department as owner_department,
          lg.id as line_group_id,
          lg.code as line_group_code,
          lg.name as line_group_name,
          lg.capacity as line_group_capacity
        from parking_places pp
        left join permanent_assignments pa
          on pa.parking_place_id = pp.id
          and pa.valid_during @> current_date
        left join users u on u.id = pa.user_id
        left join line_groups lg on lg.id = pp.line_group_id
        where pp.deleted_at is null
        order by pp.floor_label nulls last, pp.code
      `
    );

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        places: places.map((place) => ({
          id: place.id,
          code: place.code,
          title: place.title,
          floorLabel: place.floor_label,
          placeType: place.place_type,
          guestPriorityRank: place.guest_priority_rank,
          isActive: place.is_active,
          permanentOwner: place.owner_user_id
            ? {
                id: place.owner_user_id,
                displayName: place.owner_display_name,
                department: place.owner_department
              }
            : null,
          lineGroup: place.line_group_id
            ? {
                id: place.line_group_id,
                code: place.line_group_code,
                name: place.line_group_name,
                capacity: place.line_group_capacity
              }
            : null
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

async function handleAdminPlaceReleasesList(searchParams) {
  const dateFrom = searchParams.get('dateFrom');
  const dateTo = searchParams.get('dateTo');

  if ((dateFrom && !isIsoDate(dateFrom)) || (dateTo && !isIsoDate(dateTo))) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'dateFrom and dateTo must use YYYY-MM-DD format'
      }
    };
  }

  const releases = await queryMany(
    `
      select
        pr.id,
        lower(pr.release_during)::date as date_from,
        (upper(pr.release_during)::date - 1) as date_to,
        pr.status,
        pr.created_via,
        pr.created_at,
        pr.notes,
        u.id as user_id,
        u.display_name as user_display_name,
        u.department as user_department,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.title as parking_place_title,
        pp.place_type as parking_place_type
      from place_releases pr
      join users u on u.id = pr.user_id
      join parking_places pp on pp.id = pr.parking_place_id
      where pr.status = 'active'
        and ($1::date is null or pr.release_during && daterange($1::date, ($2::date + 1), '[)'))
      order by lower(pr.release_during), pp.code
    `,
    [dateFrom || null, dateTo || dateFrom || null]
  );

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      releases: releases.map((release) => ({
        id: release.id,
        dateFrom: release.date_from,
        dateTo: release.date_to,
        status: release.status,
        createdVia: release.created_via,
        createdAt: release.created_at,
        notes: release.notes,
        user: {
          id: release.user_id,
          displayName: release.user_display_name,
          department: release.user_department
        },
        parkingPlace: {
          id: release.parking_place_id,
          code: release.parking_place_code,
          title: release.parking_place_title,
          placeType: release.parking_place_type
        }
      }))
    }
  };
}

async function handleAdminPlaceReleaseCreate(req) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'Request body must be valid JSON'
      }
    };
  }

  const parkingPlaceId = body.parkingPlaceId;
  const dateFrom = body.dateFrom;
  const dateTo = body.dateTo || dateFrom;
  const notes = typeof body.notes === 'string' ? body.notes.trim() || null : null;

  if (!parkingPlaceId || !isIsoDate(dateFrom) || !isIsoDate(dateTo)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'parkingPlaceId, dateFrom and dateTo are required; dates must use YYYY-MM-DD format'
      }
    };
  }

  if (dateTo < dateFrom) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'dateTo must be greater than or equal to dateFrom'
      }
    };
  }

  const client = await pool.connect();

  try {
    await client.query('begin');

    const ownerResult = await client.query(
      `
        select
          pa.user_id,
          u.display_name as user_display_name,
          pp.code as parking_place_code
        from permanent_assignments pa
        join users u on u.id = pa.user_id
        join parking_places pp on pp.id = pa.parking_place_id
        where pa.parking_place_id = $1
          and pa.valid_during @> $2::date
          and pa.valid_during @> $3::date
        order by lower(pa.valid_during) desc
        limit 1
      `,
      [parkingPlaceId, dateFrom, dateTo]
    );

    const owner = ownerResult.rows[0];
    if (!owner) {
      await client.query('rollback');
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Parking place has no permanent owner for the selected date range'
        }
      };
    }

    const overlapResult = await client.query(
      `
        select id
        from place_releases
        where parking_place_id = $1
          and status = 'active'
          and release_during && daterange($2::date, ($3::date + 1), '[)')
        limit 1
      `,
      [parkingPlaceId, dateFrom, dateTo]
    );

    if (overlapResult.rows[0]) {
      await client.query('rollback');
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Parking place already has an active release overlapping this date range'
        }
      };
    }

    const releaseResult = await client.query(
      `
        insert into place_releases (
          user_id,
          parking_place_id,
          release_during,
          created_via,
          notes
        )
        values (
          $1,
          $2,
          daterange($3::date, ($4::date + 1), '[)'),
          'admin_web',
          $5
        )
        returning
          id,
          lower(release_during)::date as date_from,
          (upper(release_during)::date - 1) as date_to,
          status,
          created_via,
          created_at
      `,
      [owner.user_id, parkingPlaceId, dateFrom, dateTo, notes]
    );

    const release = releaseResult.rows[0];

    await client.query(
      `
        insert into audit_logs (
          entity_type,
          entity_id,
          action,
          actor_service,
          metadata
        )
        values (
          'place_release',
          $1,
          'place_release_created',
          'admin-web',
          $2::jsonb
        )
      `,
      [
        release.id,
        JSON.stringify({
          userId: owner.user_id,
          userDisplayName: owner.user_display_name,
          parkingPlaceId,
          parkingPlaceCode: owner.parking_place_code,
          dateFrom,
          dateTo,
          createdVia: 'admin_web'
        })
      ]
    );

    await client.query('commit');

    return {
      statusCode: 201,
      payload: {
        status: 'ok',
        service: 'api',
        release: {
          id: release.id,
          dateFrom: release.date_from,
          dateTo: release.date_to,
          status: release.status,
          createdVia: release.created_via,
          createdAt: release.created_at,
          user: {
            id: owner.user_id,
            displayName: owner.user_display_name
          },
          parkingPlace: {
            id: parkingPlaceId,
            code: owner.parking_place_code
          }
        }
      }
    };
  } catch (error) {
    await client.query('rollback');

    return {
      statusCode: 500,
      payload: {
        status: 'error',
        service: 'api',
        error: error.message
      }
    };
  } finally {
    client.release();
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

  if (req.method === 'GET' && url.pathname === '/admin/places') {
    const result = await handleAdminPlacesList();
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/admin/place-releases') {
    try {
      const result = await handleAdminPlaceReleasesList(url.searchParams);
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      sendJson(res, 500, {
        status: 'error',
        service: 'api',
        error: error.message
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/admin/place-releases') {
    const result = await handleAdminPlaceReleaseCreate(req);
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    sendJson(res, 200, {
      status: 'ok',
      service: 'api',
      message: 'Parking Assistant API is running',
      endpoints: [
        '/health',
        '/health/db',
        '/auth/bootstrap-status',
        '/admin/users',
        '/admin/places',
        '/admin/place-releases'
      ]
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
