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
- `JOBS_SERVICE_TOKEN` — общий секрет, с которым планировщик проходит в закрытый API
  (`openssl rand -hex 32`, свой на каждое окружение). Пустым оставлять нельзя: тогда все пять
  регламентных прогонов получат `401` и ничего по расписанию не выполнится;
- параметры `Yandex Messenger` (пока не используются — `bot-adapter` в стек не входит);
- порты стенда: `API_PORT=3330`, `ADMIN_UI_PORT=3340`.

`POSTGRES_PASSWORD` действует **только при инициализации пустого кластера**. На уже существующем
`staging/postgres` PostgreSQL сохраняет тот пароль, с которым его создали, и расхождение проявится
как невозможность `api` подключиться к базе — не как потеря данных.

### 5. Деплой

Одна идемпотентная команда, запускается на сервере:

```bash
/opt/git/parkingassistant/scripts/deploy/stand.sh
```

Что она делает: отказывается работать на грязном чекауте, делает `git pull --ff-only`, запускает
`docker compose --env-file staging/env/app.env up -d --build` и ждёт, пока `api` и `admin-ui`
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
arcane restart parkingassistant-admin-ui
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

## First run: задать пароль администратора

**Это первый шаг после миграций — до него не работает ничего.** API закрыт по умолчанию
([ADR 007](docs/adr/007-session-based-access-control.md)): без сессии отвечают только
`/health`, `/health/db`, `/auth/bootstrap-status` и четыре `/auth/*` — плюс индекс `GET /`,
который роутер отдаёт сам, минуя таблицу. Остальное — `401`.
Сессию выдаёт только `POST /auth/login`, а пароля ни у кого ещё нет: seed
`packages/db/seeds/001_bootstrap_system_admin.sql` создаёт `sysadmin` со статусом `invited` и
литеральной заглушкой `{PENDING_IMPLEMENTATION}` вместо хеша. Войти с ней нельзя.

Открыть `http://<хост>:3340/` — вместо формы входа admin UI покажет экран первичной активации
(он спрашивает `/auth/bootstrap-status` и видит `invited`). Логин подставлен — `sysadmin`;
нужно задать пароль **не короче 10 символов** и повторить его.

То же самое без браузера:

```bash
curl -s http://<хост>:3330/auth/bootstrap-status      # ожидаем "authStatus":"invited"
curl -s -X POST http://<хост>:3330/auth/activate \
  -H 'content-type: application/json' \
  -d '{"login":"sysadmin","password":"<не короче 10 символов>"}'
```

Активация разрешена **один раз**: только пока `auth_users` содержит ровно одну строку и та
всё ещё `invited`. Дальше маршрут отказывает навсегда (`409 Activation is not available` — тем
же текстом на все причины отказа, чтобы не подтверждать существование логинов), а пароли
назначает `system_admin` на вкладке `Доступ`.

Что сделать сразу после активации:

1. завести на вкладке `Доступ` учётную запись с ролью `parking_admin` для повседневной работы;
2. перестать пользоваться `sysadmin` для операций — он нужен только для учётных записей.

Сам `sysadmin` себя не разблокирует обратно: системный администратор не может ни снять с себя
роль `system_admin`, ни отключить свою учётную запись (`409` в обоих случаях). Это сделано
ровно против того, чтобы в установке с одним администратором не осталось ни одного входа.

⚠️ Сессионная cookie не `Secure`: стенд на plain HTTP, и с `Secure` браузер бы её выбросил.
На локальной сети это приемлемо, за пределами — нет, нужен TLS.

⚠️ `JWT_SECRET` и `SESSION_SECRET` этой схемой не используются вообще: токен сессии случайный,
в базе лежит его `sha256`, общим секретом ничего не подписывается. Из `.env.example` и compose
они убраны; если в `staging/env/app.env` на стенде ещё лежат `change-me`, их можно удалить — ни
на что не влияют.

⚠️ Единственный секрет, который API действительно читает помимо пароля базы, — это
`JOBS_SERVICE_TOKEN`: значение должно совпадать у сервисов `api` и `jobs`. Проверить, что
планировщик проходит, можно по логу контейнера:

```bash
docker logs parkingassistant-jobs --tail 20     # ожидаем scheduler_started, не service_token_missing
```

Если в логе `job_failed` с `status: 401` и `cause: rejected_by_api_access_control` — токены
разошлись.

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
`apps/api/testing/boot-api.js` (поднимает `apps/api/src/server.js` на свободном порту, ждёт
`/health` **и входит как `sysadmin`**) и `apps/api/testing/fixtures.js` (сотрудники, места,
линии, релизы, очередь — чтобы предусловия теста читались одним блоком). Сессия при этом
нигде не повторяется вручную: `startApi` кладёт полученную cookie в `apps/api/testing/session.js`
под своим base URL, а `postJson`/`getJson` её оттуда достают. Подробности — в `AGENTS.md` →
Testing.

`node --test` запускает каждый файл в отдельном процессе, поэтому наборы применяют схему
параллельно. `CREATE EXTENSION IF NOT EXISTS` не атомарен относительно конкурентного
создания того же расширения, а расширения живут на уровне базы, а не схемы — поэтому
харнесс сериализует применение SQL через `pg_advisory_lock`. Без этого часть наборов
падала с `duplicate key value violates unique constraint "pg_extension_name_index"`.

## Stand deployment

Стек `docker-compose.yml`: `postgres`, one-shot `migrate`, `api` (`3330`), `admin-ui` (`3340`),
`jobs`. `bot-adapter` в стек не входит — фаза Yandex Messenger отложена.

Образы собираются из `infra/docker/{app,admin-ui,jobs}.Dockerfile` и самодостаточны: исходники
копируются на этапе build, монтируется только storage (`postgres`, `maps`, `imports`, `logs`,
`backups`). У `admin-ui` сборка двухстадийная: Vite собирает бандл, в runtime-слой попадают
только `server.js`, `packages/shared/multipart.js` и `dist` — причём в том же дереве каталогов,
что и в репозитории: `server.js` импортирует парсер относительным путём.

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
6. **Задать пароль `sysadmin` через экран первичной активации** — см. «First run» выше. До
   этого шага админка не пускает никого, и это ожидаемо.
7. Завести `parking_admin` на вкладке `Доступ` и работать под ним.
8. При необходимости загрузить демо-данные: `npm run db:seed:demo` с `DATABASE_URL` стенда.

⚠️ **Регламентные задачи на стенде пока не идут.** `jobs` ходит в `/admin/jobs/*` без сессии, а
эти маршруты закрыты с M7, поэтому все пять прогонов (`07:00`, `08:00`, `08:05` и два в `19:00`)
отвечают `401` — `process_queue`, который раздаёт освобождённые места, в том числе.
`npm run smoke:stand` этого не покажет: он проверяет `/health`, `/health/db` и оболочку SPA.
Пока нет сервисного аккаунта или общего секрета, задачи надо запускать вручную со вкладки
`Журнал` (там же видно время последнего успешного прогона). См. Known Gaps в
`docs/TECHNICAL_README.md`.
