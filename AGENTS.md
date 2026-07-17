# AGENTS.md

Guidance for AI coding agents (ralphex, Claude Code, Codex, Copilot CLI) working in this repo.

## What this project is

Office parking management system. Node.js 22 monorepo, **CommonJS** (`require`/`module.exports`),
plain Node `http` (no web framework), PostgreSQL 16. Only runtime deps are `pg` and `xlsx`.

## Layout

- `apps/api` — HTTP API. Business logic lives in `apps/api/src/server.js` and `apps/api/src/services/`.
- `apps/admin-web` — server-rendered admin UI.
- `apps/bot-adapter` — Yandex Messenger bot.
- `apps/jobs` — scheduled jobs (19:00, 07:00, daily rules).
- `packages/shared` — pure utilities (`dates`, `errors`, `http`, `html`). Easiest place to add tests.
- `packages/db/schema` — SQL migrations (source of truth for the data model).

## Validation gate — run before marking any task complete

```bash
npm run check   # node --check syntax on all entrypoints
npm run lint    # eslint (must be 0 errors)
npm test        # node --test runner
```

All three must pass. This is the definition of "done" for automated loops — do not mark a task
complete or commit if any of them fail. CI (`.github/workflows/ci.yml`) runs the same three steps.

## Conventions

- CommonJS only. No ESM `import`/`export`, no TypeScript, no build step.
- Match the surrounding style: `'use strict'` at file top, 2-space indent, single quotes.
- Prefer adding pure, testable functions in `packages/shared` and covering them with `*.test.js`
  files colocated next to the source (see `packages/shared/dates.test.js`).
- Keep the dependency list minimal — justify any new runtime dependency.

## Testing

Uses the built-in Node test runner (`node:test` + `node:assert/strict`) — no external framework.
Add tests as `<name>.test.js` next to the code. Business rules worth covering first: queue
processing, multi-line occupancy limits, guest 5-place reserve, and the timed jobs.
