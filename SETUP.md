# Setup

## Goal

На `MacBook` и на `OMV` используем одинаковую структуру проекта.

Корень runtime-артефактов:

- `staging/` в корне проекта (в git не хранится — см. `/staging/` в `.gitignore`)

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

Стенд деплоится **из git-чекаута на самом сервере**. Почему именно так, а не через GitOps
менеджера контейнеров — в [ADR 005](docs/adr/005-stand-deploy-via-host-checkout.md): Arcane
синхронизирует из репозитория только compose-файл, а четыре сервиса из пяти собираются
`build: context: .`, и собирать там нечего.

### 1. Разместить чекаут

```text
/opt/git/parkingassistant
```

Это и корень проекта, и build context, и место, где лежит `staging/`:

```text
/opt/git/parkingassistant/
├── docker-compose.yml          # "." указывает сюда
├── apps/ packages/ infra/ scripts/
└── staging/                    # вне git, переживает любой редеплой
    ├── env/app.env
    ├── postgres/
    └── maps/ imports/ logs/ backups/
```

```bash
git clone https://github.com/delonet-ai/parkingassistant.git /opt/git/parkingassistant
```

Каталог должен принадлежать пользователю, под которым идёт деплой (`deployer`), иначе
`git pull` на сервере не сработает.

### 2. Создать папки runtime-артефактов

```bash
mkdir -p /opt/git/parkingassistant/staging/env \
         /opt/git/parkingassistant/staging/postgres \
         /opt/git/parkingassistant/staging/maps \
         /opt/git/parkingassistant/staging/imports \
         /opt/git/parkingassistant/staging/backups \
         /opt/git/parkingassistant/staging/logs
```

Если `staging/postgres` уже непустой — там живой кластер, не трогайте его: compose примонтирует
его как есть, а `migrate` накатит только недостающие миграции.

### 3. Положить пакеты дизайн-системы

`apps/admin-ui` собирается на Vision UI, а эти пакеты живут во внутреннем реестре и в git **не
хранятся** — репозиторий публичный. Они кладутся на хост один раз, так же как `staging/env/app.env`:

```text
/opt/git/parkingassistant/vendor/
├── vi-frontend-vision-ui-1.16.0.tgz
└── vi-frontend-svgs-0.92.0.tgz
```

Без них `docker compose build admin-ui` падает на `npm ci` — громко, а не тихой сборкой без
стилей. Версии зафиксированы в `apps/admin-ui/package.json` как `file:`-зависимости и должны
совпадать с тем, что лежит в `vendor/`.

### 4. Подготовить env

```bash
cp .env.example staging/env/app.env
```

Потом отредактировать:

- пароли PostgreSQL;
- `JWT_SECRET`, `SESSION_SECRET`;
- параметры `Yandex Messenger` (пока не используются — `bot-adapter` в стек не входит);
- порты стенда: `API_PORT=3330`, `ADMIN_WEB_PORT=3340`, `ADMIN_UI_PORT=3360`.

`POSTGRES_PASSWORD` действует **только при инициализации пустого кластера**. На уже существующем
`staging/postgres` PostgreSQL сохраняет тот пароль, с которым его создали, и расхождение проявится
как невозможность `api` подключиться к базе — не как потеря данных.

### 5. Деплой

Одна идемпотентная команда, запускается на сервере:

```bash
/opt/git/parkingassistant/scripts/deploy/stand.sh
```

Что она делает: отказывается работать на грязном чекауте, делает `git pull --ff-only`, запускает
`docker compose --env-file staging/env/app.env up -d --build` и ждёт, пока `api` и `admin-web`
станут `healthy`. Ненулевой код возврата и последние 50 строк логов — если не дождалась.

Из dev-контейнера:

```bash
ssh omv /opt/git/parkingassistant/scripts/deploy/stand.sh
npm run smoke:stand
```

Переменные: `SKIP_PULL=1` — собрать чекаут как есть (например, непушнутую ветку), `NO_BUILD=1` —
перезапустить на уже собранных образах.

### 6. Arcane

Arcane остаётся наблюдателем и оператором уже запущенных контейнеров, но не собирает стек:

```bash
arcane ps                                   # что сейчас работает
arcane logs parkingassistant-api 100
arcane restart parkingassistant-admin-web
```

**Проект `parkingassistant` в Arcane с GitOps-привязкой трогать нельзя.** Его `redeploy` запустит
сборку, которой нечем собирать, и по дороге погасит работающие контейнеры. Его стоит удалить или
отвязать в UI; на данные и тома это не влияет.

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

- на `MacBook` допустимы относительные пути;
- в compose server-side mounts зафиксированы абсолютным `/opt/git/parkingassistant/staging/...`,
  поэтому данные стенда не зависят от того, из какой директории запущен `docker compose`;
- `build: context: .` наоборот разрешается относительно compose-файла, то есть относительно
  чекаута — это и делает деплой из чекаута рабочим.

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
`depends_on: migrate: service_completed_successfully`. Поэтому свежий деплой стека
поднимается с полной схемой без ручных шагов, а редеплой просто прогоняет миграцию вхолостую.

Это единственный путь применения SQL: тот же `runMigrations()` использует и интеграционный харнесс.

## Demo dataset

Демо-данные для стенда живут отдельно от базовых seeds — в `packages/db/seeds/demo/`, на уровень
ниже, чем читает `db:migrate`. Поэтому обычный деплой их **не** подхватывает, они грузятся только
явной командой:

```bash
DATABASE_URL=postgresql://... npm run db:seed:demo         # загрузить (или перезагрузить)
DATABASE_URL=postgresql://... npm run db:seed:demo:reset   # удалить демо-данные
```

Что внутри: 4 линии (две двойных, две тройных) и 5 одиночных мест на трёх этажах (G3/G4/G5),
13 сотрудников (10 с постоянным местом, 3 без), постоянные закрепления, 8 релизов, заявка
сотрудника, выданная через очередь, ещё одна в очереди и третья только что поданная, размещённый
гость и ожидающий гость, брони, планы выезда (один ранний и заблокированный — чтобы вкладка
конфликтов была непустой), сегодняшняя занятость линий и лог доступа к контактам. Даты
привязаны к «сегодня» в `Europe/Moscow`, поэтому данные не устаревают.

Загрузка идемпотентна по построению: `000_reset.sql` сначала удаляет все демо-строки, затем
`001_demo_dataset.sql` вставляет их заново. Демо-строки узнаются по тегу на своей таблице —
`users.email like '%@demo.invalid'`, `parking_places.catalog_source = 'demo'`,
`line_groups.code like 'demo-%'`, `parking_place_maps.source_checksum = 'demo'`,
`audit_logs.actor_service = 'db_seed_demo'` — так что импортированный каталог, реальные
сотрудники и bootstrap-администратор не затрагиваются.

Проверяется тестом `packages/db/integration/demo-seed.itest.js`: после загрузки дашборд и каждый
list-эндпоинт отдают непустые данные, повторная загрузка не меняет счётчики строк, а reset убирает
ровно демо-строки.

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

## Stand deployment

Стек `docker-compose.yml`: `postgres`, one-shot `migrate`, `api` (`3330`), `admin-web` (`3340`),
`jobs`. `bot-adapter` в стек не входит — фаза Yandex Messenger отложена.

Образы собираются из `infra/docker/{app,admin-web,jobs}.Dockerfile` и самодостаточны: исходники
копируются на этапе build, монтируется только storage (`postgres`, `maps`, `imports`, `logs`,
`backups`). Placeholder-команд больше нет — у каждого образа реальный `CMD`.

После деплоя стенд проверяется одной командой:

```bash
npm run smoke:stand                      # по умолчанию 192.168.0.100:3330 / :3340
SMOKE_STAND_HOST=127.0.0.1 SMOKE_STAND_API_PORT=3000 SMOKE_STAND_ADMIN_PORT=3100 npm run smoke:stand
```

Подробности потока выкатки — в `docs/TECHNICAL_README.md` → Deployment.

## Next Recommended Steps

1. Создать `staging/...` локально и на сервере.
2. Подготовить `staging/env/app.env` для обеих сред.
3. Поднять стек: `scripts/deploy/stand.sh` на сервере или
   `docker compose --env-file staging/env/app.env up -d --build` локально.
4. Убедиться, что one-shot `migrate` отработал: `docker logs parkingassistant-migrate`.
5. Проверить стенд: `npm run smoke:stand`.
6. При необходимости загрузить демо-данные: `npm run db:seed:demo` с `DATABASE_URL` стенда.
