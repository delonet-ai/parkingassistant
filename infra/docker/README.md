# Docker Layout

## Files

- `infra/docker/app.Dockerfile` - base runtime for `api`, `bot-adapter`, `jobs`
- `infra/docker/admin-web.Dockerfile` - runtime for `admin-web`

## Current State

Это инфраструктурный baseline, а не финальная сборка приложения.

Сейчас Dockerfile:

- фиксируют целевой runtime на `node:22-bookworm-slim`
- задают единый `WORKDIR`
- добавляют `dumb-init`
- оставляют placeholder-команды запуска

Когда определим package manager и framework stack, заменим placeholder-команды на реальные build и start команды.

