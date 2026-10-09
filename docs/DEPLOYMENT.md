# Deployment Architecture

## Recommended Stack

Базовая рекомендация для первой рабочей версии:

- `apps/api`: `Node.js 22`
- `apps/bot-adapter`: `Node.js 22`
- `packages/jobs`: `Node.js 22`
- `apps/admin-ui`: Vue 3 + Vite на дизайн-системе Vision UI, со своим сервером статики и прокси `/api`
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

- `parkingassistant-admin-ui`

`infra/docker/admin-ui.Dockerfile` собирает его в двух стадиях: Vite собирает бандл, а в runtime
попадают только `server.js`, `multipart.js` и `dist` — без `node_modules`.

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
    -> admin-ui
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

#### `admin-ui`

- web UI for `parking_admin` and `system_admin`
- no business logic
- talks only to `api`, through a same-origin `/api` proxy on its own server

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
- calls backend job endpoints in MVP
- writes every run to `job_runs` and `audit_logs` through the backend

#### `postgres`

- primary database
- single source of truth

## Deployment Principle

### One codebase, four deployable units

Рекомендуемая модель:

- один monorepo
- один общий runtime stack на `Node.js 22`
- четыре deployable units:
  - `admin-ui`
  - `api`
  - `bot-adapter`
  - `jobs`

Это проще сопровождать, чем отдельные технологические стеки для web, backend и bot.

## Scheduling Strategy

Рекомендуемый вариант для MVP:

- отдельный контейнер `jobs`
- cron-like scheduler внутри приложения
- backend job endpoints keep transactional locks and audit trail
- default timezone: `Europe/Moscow`
- default schedule: `07:00` lock departure editing, `08:00` process queue, `08:05` rebuild conflicts,
  `19:00` freeze next day, then `19:00` unlock employee pool
- jobs due in the same minute run sequentially in declaration order: `freeze-next-day` settles the
  released pool that `unlock-employee-pool` then measures
- every job is idempotent and records each run in `job_runs` with a status and a summary; a second
  run for the same date changes nothing and writes no duplicate audit row

Почему так:

- проще локально и в production
- не зависит от внешнего orchestrator cron
- хорошо подходит для задач на `19:00`, `07:00` и начало дня

Расписание можно менять через env:

- `JOBS_SCHEDULER_ENABLED`
- `JOB_LOCK_DEPARTURE_PLANS_TIME`
- `JOB_PROCESS_QUEUE_TIME`
- `JOB_REBUILD_CONFLICTS_TIME`
- `JOB_FREEZE_NEXT_DAY_TIME`
- `JOB_UNLOCK_EMPLOYEE_POOL_TIME`

## Networking

### External endpoints

- `admin.example.com` -> `admin-ui`
- `api.example.com` -> `api`
- `api.example.com/bot/yandex/*` -> `bot-adapter` или route через `api-gateway` слой reverse proxy

### Internal networking

- `admin-ui` -> `api`
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

Это позволит переиспользовать планы этажей и обновлять их версиями. Планы — статичные картинки-ориентиры: связь мест с инвентарём хранится в `line_groups` / `parking_places`, а не в геометрии на картинке, поэтому замена подложки ничего не ломает.

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

- compose stack: [docker-compose.yml](../docker-compose.yml)
- shared app runtime: [infra/docker/app.Dockerfile](../infra/docker/app.Dockerfile)
- admin ui runtime: [infra/docker/admin-ui.Dockerfile](../infra/docker/admin-ui.Dockerfile)
- env template: [.env.example](../.env.example)

Placeholder-уровня здесь больше нет: у каждого образа реальный `CMD`, схема накатывается one-shot
сервисом `migrate`, а стенд поднимается и проверяется двумя командами (`scripts/deploy/stand.sh`,
`npm run smoke:stand`).

## How The Stand Actually Deploys

Менеджер контейнеров на OMV — **Arcane**, не Portainer; Portainer с сервера снят. Стенд собирается
и поднимается из git-чекаута на самом хосте, потому что Arcane GitOps забирает из репозитория
только compose-файл, а четыре сервиса из пяти объявляют `build: context: .`. Полное обоснование и
отвергнутая альтернатива (образы через CI в registry) — в
[ADR 005](adr/005-stand-deploy-via-host-checkout.md), пошаговая настройка — в [SETUP.md](../SETUP.md).

```text
push в main
  -> ssh omv /opt/git/parkingassistant/scripts/deploy/stand.sh
     (git pull --ff-only -> docker compose up -d --build -> ожидание healthy)
  -> npm run smoke:stand из dev-контейнера
```

Исходники приложения **не монтируются** в `/app`: код уже лежит внутри собранного образа, а
bind mount вида `./:/app` затёр бы его содержимое вместе с `package.json`, `node_modules` и
entrypoint-ами. Монтируются только данные, и только абсолютными путями:

- `/opt/git/parkingassistant/staging/postgres`
- `/opt/git/parkingassistant/staging/maps`
- `/opt/git/parkingassistant/staging/imports`
- `/opt/git/parkingassistant/staging/logs`
- `/opt/git/parkingassistant/staging/backups`

Абсолютные пути здесь принципиальны: они делают данные стенда независимыми от того, из какой
директории запущен `docker compose`. Build context, наоборот, намеренно относительный — он
разрешается относительно compose-файла, то есть относительно чекаута.
