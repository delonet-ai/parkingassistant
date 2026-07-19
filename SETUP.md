# Setup

## Goal

На `MacBook` и на `OMV` используем одинаковую структуру проекта.

Корень runtime-артефактов:

- [staging/](/Users/deliter/Documents/GitClone/parkingassistant/staging)

Эта папка не хранится в git и используется для:

- env-файлов
- PostgreSQL data
- карт этажей
- импортов
- бэкапов
- логов

## Directory Layout

Создайте в корне проекта:

```text
staging/
  env/
  postgres/
  maps/
  imports/
  backups/
  logs/
```

## MacBook

### 1. Создать папки

В корне проекта:

```bash
mkdir -p staging/env staging/postgres staging/maps staging/imports staging/backups staging/logs
```

### 2. Подготовить env

Скопируйте шаблон:

```bash
cp .env.example staging/env/app.env
```

### 3. Запускать compose с этим env-файлом

```bash
docker compose --env-file staging/env/app.env up -d
```

### 4. Остановить

```bash
docker compose --env-file staging/env/app.env down
```

## OMV Server

### 1. Разместить проект

Рекомендуемый путь:

```text
/opt/parkingassistant
```

Для текущего server baseline у нас принят фактический путь:

```text
/opt/git/parkingassistant
```

### 2. Создать те же папки

Внутри `/opt/parkingassistant`:

```bash
mkdir -p staging/env staging/postgres staging/maps staging/imports staging/backups staging/logs
```

### 3. Подготовить env

```bash
cp .env.example staging/env/app.env
```

Потом отредактировать:

- пароли PostgreSQL
- `JWT_SECRET`
- `SESSION_SECRET`
- параметры `Yandex Messenger`
- порты, если нужно

### 4. Запуск через CLI

```bash
docker compose --env-file staging/env/app.env up -d
```

### 5. Запуск через Portainer

Вариант через stack:

- открыть Portainer
- создать `Stack`
- указать содержимое [docker-compose.yml](/Users/deliter/Documents/GitClone/parkingassistant/docker-compose.yml)
- env-переменные взять из `staging/env/app.env`
- рабочая директория стека должна соответствовать корню проекта

Если Portainer развернут на том же сервере, удобнее всего сначала клонировать проект на сервер, а потом работать со stack уже из этой папки.

## What Is Shared Between Mac And OMV

Одинаково в обеих средах:

- структура папок
- compose файл
- Dockerfile
- структура `staging/...`

Отличается только:

- содержимое `staging/env/app.env`
- реальные домены, токены, секреты и порты

Важно:

- на `MacBook` допустимы относительные пути
- для `OMV + Portainer Git stack` bind mounts должны быть абсолютными, иначе Portainer привяжет их к временному `/data/compose/<id>` workspace
- в текущем compose server-side mounts зафиксированы через `/opt/git/parkingassistant/staging/...`

## Schema migrations

Схема и базовые seeds применяются одной идемпотентной командой:

```bash
DATABASE_URL=postgresql://... npm run db:migrate
```

Что она делает:

- применяет `packages/db/schema/*.sql`, затем `packages/db/seeds/*.sql` в лексикографическом порядке;
- записывает каждый применённый файл в таблицу-леджер `schema_migrations`;
- при повторном запуске ничего не применяет (`nothing to apply — N migration(s) already recorded`).

Флаг `--no-seed` применяет только схему, без базовых seeds.

В compose это отдельный one-shot сервис `migrate`: он поднимается после `postgres` (healthy), выполняет
`npm run db:migrate` и завершается, а `api` и `jobs` стартуют только через
`depends_on: migrate: service_completed_successfully`. Поэтому свежий деплой стека в Portainer
поднимается с полной схемой без ручных шагов, а редеплой просто прогоняет миграцию вхолостую.

Это единственный путь применения SQL: тот же `runMigrations()` использует и интеграционный харнесс.

## Integration test database

Интеграционные тесты (`*.itest.js`) требуют живой PostgreSQL и запускаются отдельно от `npm test`.

### 1. Поднять эфемерный Postgres

```bash
docker compose -f docker-compose.test.yml up -d
```

Данные лежат в `tmpfs`, порт по умолчанию `5433` (переопределяется `POSTGRES_TEST_PORT`).
После `down` база исчезает — это ожидаемое поведение для тестового стенда.

### 2. Указать `DATABASE_URL_TEST`

```bash
export DATABASE_URL_TEST=postgresql://parkingassistant_test:parkingassistant_test@127.0.0.1:5433/parkingassistant_test
```

Подойдёт и любая другая база, в которой у пользователя есть право `CREATE SCHEMA`.
Существующие данные не затрагиваются: каждый прогон создаёт собственную схему
`itest_<pid>_<n>`, применяет в неё все `packages/db/schema/*.sql` и `packages/db/seeds/*.sql`,
а в конце удаляет её целиком.

### 3. Запустить

```bash
npm run test:integration
```

Если `DATABASE_URL_TEST` не задан, интеграционные наборы помечаются как `SKIP`, а не падают —
поэтому команду безопасно запускать где угодно.

### 4. Погасить

```bash
docker compose -f docker-compose.test.yml down
```

Хелперы: `packages/db/testing/harness.js` (схема + сиды + очистка),
`apps/api/testing/boot-api.js` (поднимает `apps/api/src/server.js` на свободном порту и ждёт
`/health`) и `apps/api/testing/fixtures.js` (сотрудники, места, линии, релизы, очередь —
чтобы предусловия теста читались одним блоком). Подробности — в `AGENTS.md` → Testing.

`node --test` запускает каждый файл в отдельном процессе, поэтому наборы применяют схему
параллельно. `CREATE EXTENSION IF NOT EXISTS` не атомарен относительно конкурентного
создания того же расширения, а расширения живут на уровне базы, а не схемы — поэтому
харнесс сериализует применение SQL через `pg_advisory_lock`. Без этого часть наборов
падала с `duplicate key value violates unique constraint "pg_extension_name_index"`.

## Current Limitation

Сервисы `api`, `admin-web`, `bot-adapter`, `jobs` пока запускаются с placeholder-командами.

Это нормально на текущем этапе: инфраструктурный baseline уже зафиксирован, но реальный runtime будет подключен после выбора package manager/framework и добавления app skeleton.

## Next Recommended Steps

1. Создать `staging/...` локально и на сервере.
2. Подготовить `staging/env/app.env` для обеих сред.
3. Поднять `postgres` и проверить доступность контейнера.
4. Прогнать [packages/db/schema/001_initial_schema.sql](/Users/deliter/Documents/GitClone/parkingassistant/packages/db/schema/001_initial_schema.sql) на живой БД.
5. Прогнать `sh scripts/db/seed.sh`.
6. После этого проверить, что в БД создан bootstrap `system_admin`.
