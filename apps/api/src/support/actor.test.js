'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { ADMIN_UI, BOT, JOBS, auditActor, requestActor } = require('./actor');

describe('requestActor', () => {
  it('names the resolved operator and the admin UI by default', () => {
    const actor = requestActor({ authUser: { id: 'u1', login: 'sysadmin' }, roles: ['system_admin'] });

    assert.deepEqual(actor, { authUserId: 'u1', service: ADMIN_UI });
  });

  it('takes the service from the caller, because one handler serves /admin and /bot', () => {
    const actor = requestActor({ authUser: { id: 'u1' } }, BOT);

    assert.deepEqual(actor, { authUserId: 'u1', service: BOT });
  });

  // A public route resolves nobody, and the router hands the handler `authUser: null`. The
  // actor still has to be constructible: writing "nobody" is the honest answer, and it is
  // what `audit_logs.actor_auth_user_id` is nullable for.
  it('carries no person when the context resolved nobody', () => {
    assert.deepEqual(requestActor({ authUser: null }), { authUserId: null, service: ADMIN_UI });
    assert.deepEqual(requestActor(undefined), { authUserId: null, service: ADMIN_UI });
  });

  // A request the router let in on the service token: no person, and the label the router set
  // rather than the route's default. Calling that run `admin-ui` would read as an operator
  // opening a screen at 07:00, which is the lie `audit-actor.itest.js` exists to prevent.
  it('names the service client, not the route default, for a token-authenticated request', () => {
    assert.deepEqual(requestActor({ authUser: null, roles: [], serviceClient: JOBS }), {
      authUserId: null,
      service: JOBS
    });
  });

  // The flag wins over whatever the route passes, and over a session that is not there: the
  // router sets it only when the token was what opened the door.
  it('ignores the route default and any authUser when the service client is set', () => {
    assert.deepEqual(requestActor({ authUser: { id: 'u1' }, serviceClient: JOBS }, BOT), {
      authUserId: null,
      service: JOBS
    });
  });
});

describe('auditActor', () => {
  it('maps an actor onto the two audit columns', () => {
    assert.deepEqual(auditActor({ authUserId: 'u1', service: ADMIN_UI }), {
      actorAuthUserId: 'u1',
      actorService: ADMIN_UI
    });
  });

  // The column is `not null`, so a missing service has to become something rather than
  // taking the insert down — and the fallback is the caller's to choose.
  it('falls back to the service the caller names when there is no actor', () => {
    assert.deepEqual(auditActor(null, JOBS), { actorAuthUserId: null, actorService: JOBS });
    assert.deepEqual(auditActor(undefined), { actorAuthUserId: null, actorService: ADMIN_UI });
  });

  // A job started by the scheduler has no operator; one started by an administrator in the UI
  // does. The same fallback serves both, which is why the jobs service passes `JOBS`.
  it('keeps a named operator even when a fallback service is offered', () => {
    assert.deepEqual(auditActor({ authUserId: 'u1', service: ADMIN_UI }, JOBS), {
      actorAuthUserId: 'u1',
      actorService: ADMIN_UI
    });
  });

  it('never reports an empty id as a person', () => {
    assert.equal(auditActor({ authUserId: '', service: ADMIN_UI }).actorAuthUserId, null);
  });
});
