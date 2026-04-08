# Deployment Architecture

## Recommended Stack

Базовая рекомендация для первой рабочей версии:

- `apps/api`: `Node.js 22`
- `apps/bot-adapter`: `Node.js 22`
- `packages/jobs`: `Node.js 22`
- `apps/admin-web`: `Next.js` или другой Node-based web app с отдельным web image
- `PostgreSQL 16`
- `Redis` опционально, только если позже понадобится очередь, rate limit или pub/sub

## Target Docker Images

### Base runtime image for backend services

Рекомендуемый базовый образ:

- `node:22-bookworm-slim`

Почему именно он:

- стабильнее для production, чем `alpine`, если появятся нативные зависимости
- проще для PDF/image tooling, Excel import libs и возможных headless задач
- одинаково подходит для `api`, `bot-adapter` и `jobs`

Целевые сервисные образы:

- `parkingassistant-api`
- `parkingassistant-bot-adapter`
- `parkingassistant-jobs`

Все три можно собирать из одного общего Dockerfile с разными `target` или `CMD`.

### Admin web image

Рекомендуемый образ:

- runtime тоже на базе `node:22-bookworm-slim`

Целевой образ:

- `parkingassistant-admin-web`

Если admin UI будет на `Next.js standalone`, образ получится компактным и удобным для деплоя за reverse proxy.

### Infrastructure images

- `postgres:16-bookworm`
- `redis:7-bookworm` только при реальной необходимости
- reverse proxy: `caddy:2` или `nginx:stable`

## Recommended Production Topology

### Minimal production layout

Для первой production-версии достаточно такой схемы:

```text
Internet
  -> Reverse Proxy
    -> admin-web
    -> api
    -> bot-adapter webhook endpoint
  -> PostgreSQL
  -> jobs worker
```

### Services

#### `reverse-proxy`

- TLS termination
- routing by host/path
- access logs
- optional basic IP allowlist for admin entrypoints

#### `admin-web`

- web UI for `parking_admin` and `system_admin`
- no business logic
- talks only to `api`

#### `api`

- canonical backend
- auth
- parking rules
- assignment history
- map layer data
- audit log

#### `bot-adapter`

- receives `Yandex Messenger` webhooks
- validates incoming requests
- calls `api`
- formats bot responses

#### `jobs`

- separate long-running container
- runs scheduled tasks
- writes through backend domain/repository layer or dedicated internal application services

#### `postgres`

- primary database
- single source of truth

## Deployment Principle

### One codebase, four deployable units

Рекомендуемая модель:

- один monorepo
- один общий runtime stack на `Node.js 22`
- четыре deployable units:
  - `admin-web`
  - `api`
  - `bot-adapter`
  - `jobs`

Это проще сопровождать, чем отдельные технологические стеки для web, backend и bot.

## Scheduling Strategy

Рекомендуемый вариант для MVP:

- отдельный контейнер `jobs`
- cron-like scheduler внутри приложения
- distributed lock в PostgreSQL для защиты от двойного запуска

Почему так:

- проще локально и в production
- не зависит от внешнего orchestrator cron
- хорошо подходит для задач на `19:00`, `07:00` и начало дня

## Networking

### External endpoints

- `admin.example.com` -> `admin-web`
- `api.example.com` -> `api`
- `api.example.com/bot/yandex/*` -> `bot-adapter` или route через `api-gateway` слой reverse proxy

### Internal networking

- `admin-web` -> `api`
- `bot-adapter` -> `api`
- `jobs` -> `postgres`
- `api` -> `postgres`

Если хотим максимально простую архитектуру, `jobs` может работать через те же application modules, что и `api`, но без отдельного HTTP hops.

## Storage

### Database

- persistent volume only for `PostgreSQL`

### Floor maps and imported source files

Рекомендуемый подход:

- не хранить PDF и Excel только внутри контейнера
- хранить исходники в object storage или в отдельном mounted volume
- в БД хранить metadata, version, checksum, file path/object key

Это позволит переиспользовать карты этажей, обновлять их версиями и не терять связь с кликабельными зонами.

## Secrets and Config

Конфиг через env vars:

- `DATABASE_URL`
- `APP_TIMEZONE`
- `JWT_SECRET`
- `SESSION_SECRET`
- `YANDEX_MESSENGER_*`
- `MAP_STORAGE_*`
- `IMPORT_STORAGE_*`

Секреты:

- только через secret store или deployment platform secrets
- не через `.env` в production

## Why This Is The Default Recommendation

Этот вариант хорошо подходит под текущий объём проекта, потому что:

- мало operational overhead
- простой локальный запуск через `docker compose`
- ясный путь к production
- не мешает потом перейти в Kubernetes или Nomad
- позволяет вынести `jobs` и `bot-adapter` отдельно по мере роста нагрузки

## Future Scale Path

Если система вырастет, эволюция может быть такой:

1. вынести `jobs` в отдельный autoscaled worker pool
2. добавить `Redis` для очередей и временных блокировок
3. вынести file/object storage для карт и импортов
4. поставить managed `PostgreSQL`
5. перейти на orchestrator уровня Kubernetes

## Repository Baseline

В репозитории уже зафиксирован стартовый infra baseline:

- compose stack: [docker-compose.yml](/Users/deliter/Documents/GitClone/parkingassistant/docker-compose.yml)
- shared app runtime: [infra/docker/app.Dockerfile](/Users/deliter/Documents/GitClone/parkingassistant/infra/docker/app.Dockerfile)
- admin web runtime: [infra/docker/admin-web.Dockerfile](/Users/deliter/Documents/GitClone/parkingassistant/infra/docker/admin-web.Dockerfile)
- env template: [.env.example](/Users/deliter/Documents/GitClone/parkingassistant/.env.example)

Это пока placeholder-уровень для запуска сервисов и фиксации архитектуры. Следующим шагом сюда должны лечь реальные команды сборки и старта после выбора package manager и framework stack.

## Important Portainer Note

Для server-side stack через Portainer не нужно монтировать исходники приложения в `/app`.

Почему:

- код уже должен находиться внутри собранного image
- bind mount вида `./:/app` в Portainer может затереть содержимое image
- это особенно ломает `package.json`, `node_modules` и runtime entrypoints

Для server deployment оставляем только data mounts:

- `./staging/postgres`
- `./staging/maps`
- `./staging/imports`
- `./staging/logs`
- `./staging/backups`
