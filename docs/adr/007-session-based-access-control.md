# ADR 007: Access Control on Server-Side Sessions, Closed by Default

## Status

Accepted. Implements milestone M7
([plan](../plans/20261010-auth-and-operator-features.md)) and supersedes the unused
`JWT_SECRET` / `SESSION_SECRET` placeholders in `staging/env/app.env`, which this design
needs neither of.

## Context

The admin UI was open: anyone who could reach port `3340` operated the parking. The schema
for access control had been in place since `001_initial_schema.sql` — `auth_users`,
`auth_roles`, `auth_user_roles`, `auth_sessions`, and an `actor_auth_user_id` column on every
history table — and two read endpoints existed. Everything that *writes* was missing:
password verification, sessions, a guard on the API, and the screens.

Three decisions had to be made, and each had a cheaper wrong answer:

1. **Where the session lives.** A signed JWT needs no table and no lookup; a row in
   `auth_sessions` needs both.
2. **How a route becomes closed.** A list of protected prefixes is one line of code; a flag
   on every route table entry touches all ~60 of them.
3. **How the very first password gets set.** The seeded bootstrap user
   (`packages/db/seeds/001_bootstrap_system_admin.sql`) carries the literal placeholder
   `{PENDING_IMPLEMENTATION}` as its hash, so there is no credential to start from and no
   signed-in operator who could create one.

## Decision

### A server-side session table, not a JWT

The session is 32 random bytes (`base64url`) in an `HttpOnly` cookie named `pa_session`. The
database stores only `sha256(token)` in `auth_sessions.session_token_hash`, which is already
unique-indexed. TTL is 12 hours — one working day plus the evening jobs.

The reason is **revocation**, and it is not hypothetical here. `POST /admin/users/disable`
revokes that account's live sessions **in the same transaction**, so the change takes effect
at the next request rather than at the next expiry. The same applies to a
role change: the roles are read from the session row's joins on every request, so demoting a
`system_admin` closes the user-management routes immediately. A JWT carrying roles in its
payload would keep answering with the old ones until it expired, and the only fix for that is
a server-side denylist — i.e. the table, plus a token format that still cannot be trusted on
its own.

The storage shape follows from the same reasoning: because the row stores a hash rather than
the token, a database dump does not hand over live sessions, and the hash cannot be replayed
as a cookie. `last_seen_at` is bumped on each resolve; `expires_at` is **not** extended, so a
session has a fixed lifetime rather than a sliding one.

There is no dependency to add. `node:crypto` provides `randomBytes`, `createHash`, `scrypt`
and `timingSafeEqual`, which is the whole credential layer.

### Passwords: scrypt with its cost stored alongside the hash

`packages/shared/passwords.js` stores
`scrypt$16384$8$1$<base64 salt>$<base64 hash>` — the cost parameters travel with the hash, so
they can be raised later without invalidating existing credentials. Comparison is
`timingSafeEqual` on equal-length buffers.

The login path verifies against a **decoy hash** when there is no usable credential (unknown
login, disabled account). Without it, an unknown login would answer measurably faster than a
wrong password and `POST /auth/login` would enumerate logins by timing. For the same reason
there is one refusal message — `Invalid login or password` — for every losing path, and one
(`Activation is not available`) for every refused activation.

### Deny by default, at the router

A route is closed unless its table entry says `public: true`. **Seven** table routes are
public and nothing else is:

- `GET /health` and `GET /health/db` — the container probes them before anyone can sign in;
- `GET /auth/bootstrap-status` — what the login screen reads to choose between "sign in" and
  "set the first password";
- the four `/auth/*` routes that establish a session. Requiring one would close the only door
  in, so each enforces its own rule instead: `POST /auth/activate` only while the database
  holds the single `invited` bootstrap user, `POST /auth/login` as described above,
  `GET /auth/me` answering 401 when the cookie resolves to nobody (which is how the UI decides
  to show the login screen at all), and `POST /auth/logout` idempotently.

The index at `GET /` is answered by the router itself after the table misses, so it is reachable
without a session and is not a table entry.

`roles` on a route narrows it further: a session whose roles do not intersect the list answers
**403**, never 404. Hiding a route from a signed-in operator with the wrong role would make a
misconfigured account indistinguishable from a bug. The six account routes — `GET /admin/users`
plus `POST /admin/users`, `/admin/users/roles`, `/admin/users/password`, `/admin/users/disable`
and `/admin/users/enable` — carry `roles: ['system_admin']`; every other closed route means
"any signed-in operator".

What makes "deny by default" true rather than aspirational is `apps/api/src/route-access.test.js`:
it enumerates the **composed** route table, fails if the public set is anything but those seven
routes or the role-scoped set anything but those six, and drives every other registered route
through a real router whose session store resolves nobody — asserting it answers 401 rather than
merely that it is marked closed. The probe set is **derived from the table**, including the
pattern routes, whose paths are generated from the pattern source. A route added without
thinking about access is closed, and the test proves it. (This was not free: the hand-written
half of that list had quietly missed `GET /admin/line-groups/:id/occupancy`, which was closed
but never actually called anonymously — which is why both halves are now derived and the probe
count is itself asserted against the table.)

The guard resolves the cookie **once** per request and hands `{ authUser, roles, session }` to
the handler. `apps/api/src/support/actor.js` is the one place that turns that into the two
audit columns, so a service can name the actor but cannot reach the session row, bump
`last_seen_at` or read the roles.

### The cookie is not `Secure`

The stand serves plain HTTP on `3330`/`3340`. Setting `Secure` would make the browser drop the
cookie and nobody could sign in. `HttpOnly` and `SameSite=Lax` are set.

This is recorded as a property of the **deployment**, not of the code: behind TLS the attribute
should be added, and `apps/api/src/support/cookies.js` says so at the point where it would go.
Until then the session travels in clear on the local network, which is the same exposure the
Postgres port published on the host already has, and is tracked with it in M9.

### First-run activation

`POST /auth/activate` sets the bootstrap user's password, and is allowed **only** while
`auth_users` holds exactly one row, that row is still `invited`, and the submitted login
matches it. All three are checked inside a transaction over `select … for update` on the table,
so two activations racing cannot both win. After that the route refuses forever and passwords
are set by a `system_admin` through `POST /admin/users/:id/password`.

Two guards exist for the mistakes a role cannot prevent, both of which would leave the
installation with one fewer way in and, with a single administrator, with none: a `system_admin`
cannot remove their own `system_admin` role, and cannot disable their own account. Both answer
409 and name the other administrator as the way out.

## Consequences

**Every test that talks to the API needs a session.** This was the real work of closing the
API, not an afterthought: practically every request an integration suite makes now has to
carry a cookie. Threading one through ~200 `postJson`/`getJson` call sites would have stated
the same fact 200 times, so `apps/api/testing/boot-api.js` signs in during `startApi` and
registers the cookie against the base URL it is listening on, and the request helpers in
`fixtures.js` look it up. The `cookie` option is tri-state: absent means "whatever the jar
holds", `null` means "send none" (how the 401 paths are asserted), a string means "send this
one" (how a second operator is exercised). A suite that boots two APIs gets two independent
sessions without saying anything.

The seeded password is written directly into the database by the helper, because activation is
a once-per-installation event a suite must be able to skip — but the sign-in itself is the real
`POST /auth/login` against a real scrypt hash, so nothing about sessions is stubbed.

**The golden snapshots did not move when the API closed.** Authentication changes *who may
ask*, not what the answer is; the harness logs in and sends the cookie, so every recorded
payload stayed byte-identical. A moving snapshot would have meant the guard touched a response
it should not have. Only Task 6 — the audit trail naming people — regenerated them, and only
the actor fields differed.

**The scheduler cannot reach the API.** `apps/jobs` calls the job endpoints over HTTP with no
credential, so the 07:00 and 19:00 runs answer 401 on the stand. This is the one acceptance
item of the M7 plan that remains false, and it needs a service account or a shared secret —
deliberately not improvised here, because the obvious shortcuts (a public job route, an
IP allowlist) each reopen part of what this ADR closed. The audit side is already prepared for
it: `auditActor` falls back to the `jobs` service label with a null `actor_auth_user_id`, which
is what the scheduler's request will produce once it has a way in, and
`apps/api/integration/audit-actor.itest.js` asserts that case in-process today.

**The UI hides a tab it cannot open, and the API still decides.** `TABS` in
`apps/admin-ui/src/store.js` carries the same `roles: ['system_admin']` on the `Доступ` tab, so
a `parking_admin` is not offered a screen whose every request would answer 403 — and a pasted
URL naming that tab falls back to the day. That duplication is labels only: hiding a tab is not
access control, and the 403 is what enforces it.

**`JWT_SECRET` and `SESSION_SECRET` are dead.** Nothing in this design signs anything with a
shared secret; the token is random and the hash is unkeyed. Both are still `change-me` in
`staging/env/app.env` and should be removed rather than filled in.
