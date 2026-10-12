'use strict';

// Who acted, as the audit trail records it.
//
// `audit_logs` has had two columns for the question since `001_initial_schema.sql`:
// `actor_service` names the application and `actor_auth_user_id` names the person. Only the
// first was ever written, so the journal could say "admin-web" — an application that has
// since been deleted — and never which operator pressed the button. The router resolves the
// session once per request and hands `authUser` to the handler; this module is the one place
// that turns it into those two columns, so a service cannot half-answer the question.
//
// A service takes an `actor` and spreads `auditActor(actor)` into its audit insert. The
// shape is deliberately small — an id and a service label — because a service must not be
// able to reach the session row, bump `last_seen_at`, or read the roles: naming the actor is
// all it is entitled to do.

// The admin UI (`apps/admin-ui`), which replaced the server-rendered `admin-web`.
const ADMIN_UI = 'admin-ui';

// The Yandex Messenger bot. A bot request carries an employee, not an operator, so its rows
// name the employee in `actor_user_id` and the bot here.
const BOT = 'bot';

// The scheduler in `apps/jobs`. A scheduled run has no operator, and the service label is
// the only honest answer: the jobs service falls back to this when nobody is signed in,
// rather than attributing the run to whoever last touched the system.
const JOBS = 'jobs';

// Built from the route context the router hands every handler. `service` is the caller's,
// because the same handler can serve `/admin/*` and `/bot/*` (departure plans do).
//
// `serviceClient` overrides that default: a request the router let in on the service token has
// no person behind it, and labelling it `admin-ui` would claim an operator opened a screen at
// 07:00. It is the router's answer to "who let this in", so it wins over the route's guess.
function requestActor(context, service = ADMIN_UI) {
  if (context && context.serviceClient) {
    return { authUserId: null, service: context.serviceClient };
  }

  return {
    authUserId: context && context.authUser ? context.authUser.id : null,
    service
  };
}

// The two audit columns for an actor. `actorService` keeps a default so a caller that
// genuinely has no actor — a job the scheduler started — still records an application; it
// is `null` that the column rejects, not an unnamed person.
function auditActor(actor, fallbackService = ADMIN_UI) {
  return {
    actorAuthUserId: (actor && actor.authUserId) || null,
    actorService: (actor && actor.service) || fallbackService
  };
}

module.exports = {
  ADMIN_UI,
  BOT,
  JOBS,
  auditActor,
  requestActor
};
