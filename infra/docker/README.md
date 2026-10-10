# Docker Layout

## Files

- `infra/docker/app.Dockerfile` - runtime for `api` and `bot-adapter`
- `infra/docker/jobs.Dockerfile` - runtime for the `jobs` scheduler
- `infra/docker/admin-ui.Dockerfile` - runtime for `admin-ui`

## Current State

Сейчас Dockerfile:

- фиксируют целевой runtime на `node:22-bookworm-slim`
- `app` и `jobs` работают из `/app`; `admin-ui` — из `/app/apps/admin-ui`, потому что его образ
  повторяет дерево репозитория: `server.js` импортирует `packages/shared/multipart.js`
  относительным путём. Топология закреплена `infra/deployment.test.js` (входит в `npm test`)
- добавляют `dumb-init`

