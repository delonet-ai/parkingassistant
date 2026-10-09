# Technical README

Актуальная техническая точка входа для разработки Parking Assistant.

Документ фиксирует фактическую архитектуру, текущий runtime, основные области кода, правила деплоя и дальнейший milestone-план. Детальные документы остаются отдельными источниками:

- [Architecture Overview](ARCHITECTURE.md)
- [Deployment Architecture](DEPLOYMENT.md)
- [ERD Draft](ERD.md)
- [docker-compose.yml](../docker-compose.yml)

## Current Status

Проект уже работает как monorepo на `Node.js 22` и `PostgreSQL 16`.

Текущие deployable units:

- `api`: backend API, бизнес-операции, работа с PostgreSQL, audit/history, jobs endpoints.
- `admin-web`: server-rendered admin UI, работает только через backend API.
- `bot-adapter`: HTTP adapter для сотруднических сценариев и будущей интеграции с Yandex Messenger.
- `jobs`: scheduler-контейнер, вызывает backend job endpoints по расписанию.
- `postgres`: основная БД и единственный источник истины.

Что уже есть в backend:

- справочники сотрудников и мест;
- постоянные закрепления;
- отдачи мест;
- заявки сотрудников;
- гостевые заявки;
- очередь;
- ручные назначения и отмены;
- гостевой резерв;
- multi-линии и фактические позиции;
- планы времени выезда;
- конфликты и предупреждения;
- audit log, contact access logs, reservation events, movement history;
- инвентарь мест: элементы-линии на 1–3 слота, роль слота, архивирование;
- job runs и ручной запуск jobs.

Что уже есть в admin UI:

- вкладка `День`: дата, KPI, операционная карта, карточка места и дневные таблицы;
- вкладка `Заявки`: заявки сотрудников, гости, очередь и обработка;
- вкладка `Линии`: позиции, выезды, конфликты и contact logs;
- вкладка `Справочники`: сотрудники, места, постоянные закрепления, истории;
- вкладка `Журнал`: audit logs, contact logs, jobs;
- вкладка `Места`: инвентарь элементов-линий, добавление и архивирование, подложки этажей.

## Architecture

Базовая схема:

```text
Admin Browser
  -> admin-web
    -> api
      -> postgres

Yandex Messenger
  -> bot-adapter
    -> api
      -> postgres

jobs
  -> api
    -> postgres
```

Ключевые правила архитектуры:

- бизнес-логика находится в backend API;
- admin-web и bot-adapter не должны дублировать парковочные правила;
- все важные изменения пишутся в audit/history;
- все временные правила работают в `Europe/Moscow`;
- PostgreSQL хранит канонические данные;
- карты и импорты лежат во mounted storage, а metadata и связи хранятся в БД.

Основные каталоги:

- `apps/api/src/server.js`: bootstrap — env, pool, сборка модулей, listen, shutdown. Handlers здесь нет.
- `apps/api/src/modules/<context>/`: bounded context: `controller.js` (HTTP), `service.js` (use case + транзакции), `repository.js` (весь SQL).
- `apps/api/src/modules/index.js`: composition root — порядок контроллеров задает endpoint index на `GET /`.
- `apps/api/src/router.js`: HTTP router, собирающий per-module route tables.
- `apps/api/src/repositories/db.js`: `queryOne`/`queryMany` и `withTransaction`.
- `apps/api/src/serializers`: общие row → JSON мапперы, которыми пользуются несколько контекстов.
- `apps/api/src/support`: request-shaped helpers (`abortWith`, `parsePositiveLimit`, …).
- `apps/admin-web/src/server.js`: bootstrap admin UI — config и listen, 17 строк.
- `apps/admin-web/src/http/`: router и три route-группы (`assets`, `page`, `forms`); весь data-fetching живет здесь.
- `apps/admin-web/src/api-client.js`: единственное место, откуда admin-web ходит в API.
- `apps/admin-web/src/pages/`: по одному renderer на вкладку + общий shell (`layout.js`) и registry (`registry.js`).
- `apps/admin-web/src/components/`: таблицы, формы и панели, из которых собираются вкладки.
- `apps/bot-adapter/src/server.js`: текущий bot adapter entrypoint.
- `apps/jobs/src/scheduler.js`: scheduler entrypoint.
- `packages/shared`: общие helpers для HTTP, дат, HTML escaping и API errors.
- `packages/db/schema`: SQL schema migrations.
- `scripts/import`: одноразовые и поддерживающие импорты каталога.
- `scripts/smoke`: локальные smoke checks.
- `infra/docker`: Docker runtime images.

Текущие команды проверки:

- `npm run check`: синтаксическая проверка JS entrypoints через `node --check`.
- `npm run smoke:m1`: локально поднимает `api` и `admin-web`, проверяет health/root/error/404/SSR paths.

## Data Model

Подробная схема описана в [ERD Draft](ERD.md).

Ключевые таблицы:

- `users`: сотрудники и гости;
- `parking_places`: канонический каталог мест;
- `line_groups`: группы multi-линий;
- `permanent_assignments`: постоянные закрепления;
- `place_releases`: отдачи закрепленных мест;
- `employee_parking_requests`: заявки сотрудников;
- `guest_parking_requests`: гостевые заявки;
- `reservations`: фактические назначения на дату;
- `queue_entries`: очередь;
- `departure_plans`: планы времени выезда;
- `line_occupancy`: фактические позиции в линиях;
- `contact_access_logs`: запросы контактов впередистоящих;
- `audit_logs`: журнал критичных действий;
- `reservation_events` и `parking_movements`: история назначений и перемещений;
- `parking_place_maps`: подложки планов этажей (статичные картинки-ориентиры);
- `line_groups`: элементы парковки — линии на 1–3 слота, `capacity` как источник истины;
- `job_runs`: история запусков фоновых задач.

Ключевые инварианты:

- одно место не может иметь два активных назначения на одну дату;
- один пользователь не может иметь два активных назначения на одну дату;
- один сотрудник не может иметь более одной активной заявки на дату;
- одна позиция линии не может быть занята двумя участниками на одну дату;
- изменения назначений, очереди, отдач и line occupancy должны выполняться транзакционно;
- audit/history должен позволять понять, кто, когда и каким способом изменил состояние.

## Admin UI

Целевое разделение UI:

- `День`: ежедневная операционная работа. План этажа — статичная картинка, а элементы под ней кликабельны: клик по слоту выбирает место и открывает карточку операций.
- `Заявки`: очередь сотрудников, гостевые заявки, создание и отмена заявок, ручная обработка.
- `Линии`: multi-линии, позиции, ранние выезды, конфликты и доступ к контактам.
- `Справочники`: сотрудники, места, постоянные закрепления, истории места и сотрудника.
- `Журнал`: audit log, contact access logs, jobs/runs.
- `Места`: инвентарь парковки — какие элементы (линии) существуют, добавление и архивирование, роль слота, подложки этажей.

Три соседние вкладки отвечают на три разных вопроса, и это разделение принципиально:

| Вкладка | Вопрос |
|---|---|
| `День` | кто где стоит сегодня и что я меняю на сегодня |
| `Линии` | кто на какой позиции внутри линии сегодня |
| `Места` | какие места существуют вообще |

Принцип: `День` только выбирает и оперирует, `Места` управляет составом инвентаря. `День` не может создать или заархивировать место, а `Места` ничего не знает о сегодняшней занятости.

## Scheduled Jobs

`apps/jobs/src/scheduler.js` — минутный тик, который вызывает job-эндпоинты API. Расписание и таймзона
берутся из env (см. `docs/DEPLOYMENT.md`); часовой пояс по умолчанию `Europe/Moscow`.

| Job | Время | Дата | Что делает |
|---|---|---|---|
| `lock_departure_plans` | 07:00 | сегодня | Проставляет `departure_plans.locked_at`; после этого upsert плана на эту дату отдаёт `409`. |
| `process_queue` | 08:00 | сегодня | Раздаёт освобождённые места из очереди, соблюдая гостевой резерв. |
| `rebuild_conflicts` | 08:05 | сегодня | Пересчитывает `departure_plans.is_early` по правилу отсечки и конфликты ранних выездов. |
| `freeze_next_day` | 19:00 | завтра | Проставляет `place_releases.frozen_at`; после этого отмена освобождения отдаёт `409`. |
| `unlock_employee_pool` | 19:00 | завтра | Считает и фиксирует, сколько мест достанется сотрудникам: всё освобождённое минус гостевой резерв. |

Правила, общие для всех job:

- **Идемпотентность.** Повторный запуск на ту же дату ничего не меняет и не пишет второй audit-row.
  Guard — это состояние в БД (`frozen_at is null`, `locked_at is null`, расхождение `is_early`), а не
  флаг в памяти планировщика.
- **Каждый запуск пишется в `job_runs`** со `status`, `summary` и `error`; неудачный запуск тоже
  записывается. Смотреть — вкладка `Журнал` или `GET /admin/jobs/runs`.
- **Порядок внутри одной минуты значим.** Job-ы выполняются последовательно в порядке объявления:
  `freeze_next_day` фиксирует пул, `unlock_employee_pool` его измеряет.
- **`freeze` не меняет `place_releases.status`.** Замороженное освобождение — всё ещё активное
  освобождение: утренний `process_queue` обязан уметь его раздать. «Заморожено» значит «нельзя
  забрать обратно», а не «больше не освобождено». Поэтому значение enum `frozen` не используется.

## Deployment

Штатный процесс:

```text
local changes
  -> git commit
  -> git push origin main
  -> ssh omv /opt/git/parkingassistant/scripts/deploy/stand.sh
  -> npm run smoke:stand
```

Важно:

- Сервер забирает код сам — скрипт деплоя начинается с `git pull --ff-only` и отказывается
  работать на грязном чекауте. Ручной `scp` файлов на сервер штатным деплоем не является.
- В compose не монтируются исходники приложения в `/app`: код попадает внутрь образа на этапе build.
- Почему деплой идёт из чекаута на хосте, а не через GitOps менеджера контейнеров —
  [ADR 005](adr/005-stand-deploy-via-host-checkout.md).

### Состав стека

`docker-compose.yml` описывает шесть сервисов, и только их:

| Сервис | Образ | Роль |
|---|---|---|
| `postgres` | `postgres:16-bookworm` | БД, healthcheck через `pg_isready` |
| `migrate` | `infra/docker/app.Dockerfile` | one-shot `npm run db:migrate`, стартует после healthy `postgres` |
| `api` | `infra/docker/app.Dockerfile` | HTTP API, порт `3330` → 3000 |
| `admin-web` | `infra/docker/admin-web.Dockerfile` | SSR-админка, порт `3340` → 3100 |
| `admin-ui` | `infra/docker/admin-ui.Dockerfile` | Vue 3 админка на Vision UI, порт `3360` → 3100 |
| `jobs` | `infra/docker/jobs.Dockerfile` | планировщик регулярных задач |

`bot-adapter` в стек **намеренно не включён**: фаза Yandex Messenger отложена до финализации логики
и UI. Entrypoint и npm-скрипт остаются в репозитории — не развёрнут только сервис.

`api` и `admin-web` имеют собственный container healthcheck (`node -e fetch(/health)`), поэтому
`admin-web` и `jobs` ждут `api: service_healthy`, а не просто «процесс запустился».

Образы самодостаточны: исходники копируются на этапе build, в compose монтируется только storage.
`app.Dockerfile` и `jobs.Dockerfile` ставят зависимости через `npm ci --omit=dev` по
`package-lock.json`; `admin-web` живёт на builtins + `packages/shared` и не несёт `node_modules`
вовсе. Топология закреплена тестом `infra/deployment.test.js` (он входит в `npm test`).

### Redeploy и smoke-проверка стенда

Штатный цикл выкатки на стенд:

```text
git push origin main
  -> ssh omv /opt/git/parkingassistant/scripts/deploy/stand.sh
     git pull --ff-only
     docker compose --env-file staging/env/app.env up -d --build
     ожидание healthy у api и admin-web
  -> migrate отрабатывает сам, внутри compose
  -> npm run smoke:stand
```

`scripts/deploy/stand.sh` идемпотентен: пересобирается только изменившееся, пересоздаются только
сервисы с новым образом или конфигом, `staging/` не трогается вовсе. `SKIP_PULL=1` собирает чекаут
как есть, `NO_BUILD=1` перезапускает на уже собранных образах.

`npm run smoke:stand` (`scripts/smoke/stand.js`) запускается из dev-контейнера и проверяет
`3330/health`, `3330/health/db`, `3340/health`, рендер `3340/?view=day`, а также `3360/health`,
оболочку SPA на `3360/` и прокси `3360/api/health`. Только чтение —
команда безопасна и против прода. Адрес переопределяется переменными
`SMOKE_STAND_HOST`, `SMOKE_STAND_API_PORT`, `SMOKE_STAND_ADMIN_PORT`, `SMOKE_STAND_TIMEOUT_MS`
(по умолчанию — стенд `192.168.0.100`).

Диагностика уже работающего стека идёт через Arcane (`arcane ps`, `arcane logs <контейнер>`,
`arcane restart <контейнер>`) или напрямую по SSH. Собирать стек Arcane не умеет — его проект
`parkingassistant` с GitOps-привязкой редеплоить нельзя, см. ADR 005.

### Schema migrations

Схема БД применяется идемпотентной командой `npm run db:migrate`
(`packages/db/migrate.js`): она прогоняет `packages/db/schema/*.sql`, затем
`packages/db/seeds/*.sql` в лексикографическом порядке и фиксирует каждый применённый файл в
таблице-леджере `schema_migrations`. Повторный запуск не применяет ничего.

В стеке это отдельный one-shot сервис `migrate`, который стартует после healthy `postgres` и
завершается до старта `api` и `jobs` (`depends_on: service_completed_successfully`). Отдельного
ручного шага при деплое нет: `push` в `main` → `scripts/deploy/stand.sh` → миграция отрабатывает сама.

Тот же `runMigrations()` использует интеграционный харнесс (`packages/db/testing/harness.js`), так
что тесты и стенд применяют SQL одним и тем же кодом. Идемпотентность закреплена тестом
`packages/db/integration/migrate.itest.js`.

### Demo dataset

Демо-набор для тестового стенда лежит в `packages/db/seeds/demo/` — на уровень ниже, чем читает
`db:migrate`, поэтому деплой его не применяет. Загрузка и сброс — явные команды:

```bash
DATABASE_URL=postgresql://... npm run db:seed:demo
DATABASE_URL=postgresql://... npm run db:seed:demo:reset
```

Набор рассчитан так, чтобы **каждая** вкладка админки отдавала содержимое: линии всех размеров,
сотрудники с постоянным местом и без, постоянные закрепления, активные релизы, заявки сотрудников
(выданная через очередь / в очереди / новая), гостевые заявки (размещённая и ожидающая), брони,
планы выезда с одним ранним и заблокированным (непустые конфликты), занятость линий, лог доступа
к контактам и записи аудита. Даты привязаны к «сегодня» в `Europe/Moscow`.

Идемпотентность обеспечена конструкцией «reset + insert»: `000_reset.sql` удаляет строки по тегу
демо-набора (`users.email like '%@demo.invalid'`, `parking_places.catalog_source = 'demo'`,
`line_groups.code like 'demo-%'`, `parking_place_maps.source_checksum = 'demo'`,
`audit_logs.actor_service = 'db_seed_demo'`), `001_demo_dataset.sql` вставляет их заново. Всё
остальное — импортированный каталог, реальные пользователи, bootstrap-администратор — не
затрагивается. Закреплено тестом `packages/db/integration/demo-seed.itest.js`.

Production storage mounts:

- `/opt/git/parkingassistant/staging/postgres`;
- `/opt/git/parkingassistant/staging/maps`;
- `/opt/git/parkingassistant/staging/imports`;
- `/opt/git/parkingassistant/staging/logs`;
- `/opt/git/parkingassistant/staging/backups`.

Текущие production ports:

- API: `3330`;
- Admin Web (SSR, уходит): `3340`;
- Admin UI (Vision UI): `3360`;
- Bot Adapter: `3350`.

### Test Stand (staging)

Тестовый стенд для проверки и перекаток:

- Хост: `192.168.0.100`. Полностью под тестирование; стек из `main` поднимается из чекаута
  `/opt/git/parkingassistant` (он же build context, `staging/` внутри него — вне git).
- Менеджер контейнеров — **Arcane** (UI на `:3552`, CLI `arcane`). Он наблюдает и оператирует
  запущенные контейнеры: `arcane ps`, `arcane logs`, `arcane restart`. Сборку он не выполняет.
- Токен Arcane хранится **вне репозитория** (`~/.arcane_token` в dev-контейнере), в git не коммитится.
- Деплой на стенд: `ssh omv /opt/git/parkingassistant/scripts/deploy/stand.sh` (см. поток выше).
- Порты на стенде соответствуют production-портам: API `3330`, Admin Web `3340`, Bot Adapter `3350`.
- SSH используется только для диагностики. Доступ настраивается **по ключу** (ed25519), ключ
  генерируется из dev-контейнера; парольный root-вход отключается после установки ключа.
  **Учётные данные (пароли, токены) в этот файл и в репозиторий не помещаются.**

### Golden HTTP snapshots (контракт поведения API)

`apps/api/test/golden/*.json` — записанные `(status, payload)` по каждой группе эндпоинтов.
Это **контракт**, который декомпозиция монолита (Phase 3: repository → domain → controller)
обязана сохранить байт в байт. Расхождение означает либо баг рефакторинга, либо намеренное
изменение, которое требуется перезаписать явно и показать в диффе коммита.

- Сценарии: `apps/api/testing/golden-scenarios.js` — список групп в порядке выполнения.
  Порядок значим: сначала все читающие группы против чистого демо-набора, затем пишущие,
  затем `jobs` (каждая из пяти job'ов трогает релизы, планы и очередь сразу).
- Нормализация: `apps/api/testing/golden.js`. Идентификаторы → `<id:N>` (сквозная нумерация
  по всему прогону — именно поэтому снапшот доказывает, что id из `POST` совпадает с id из
  последующего `GET`), даты → `<today±N>` относительно `APP_TIMEZONE`, метки времени →
  `<timestamp>`, ключи объектов сортируются, **порядок массивов сохраняется** (порядок очереди
  и позиций в линии — часть контракта).
- Запуск: `npm run test:golden` (входит и в `npm run test:integration`).

Перезапись снапшотов — **осознанное действие**, не побочный эффект прогона:

```bash
GOLDEN_UPDATE=1 npm run test:golden   # перезаписывает apps/api/test/golden/*.json
git diff apps/api/test/golden          # прочитать КАЖДУЮ строку перед коммитом
```

Снапшоты лежат в каталоге `test/` только как `*.json`: `node --test` подхватывает **любой**
`.js` под каталогом с именем `test/` независимо от имени файла, поэтому сам раннер живёт в
`apps/api/integration/golden.itest.js`, а не рядом с данными.

Списки, у которых SQL-сортировка неоднозначна, помечены в сценарии как `unordered`: внутри
них идентичность обезличивается до `<uuid>`, а строки сортируются по нормализованному
содержимому. Утверждается множество и содержимое строк, а не порядок, который Postgres
выбрал в этот раз.

Пометку `unordered` **нельзя снимать** после того, как задача 21 добавила `, id desc` в
`order by` журналов. Tiebreaker чинит настоящий дефект — повторное чтение и страница с
`limit` внутри одной базы теперь стабильны, — но снапшот ordered не делает: `id` это
`gen_random_uuid()`, поэтому порядок строк с одинаковой меткой времени заново перемешивается
на каждой свежей scratch-схеме.

## Technical Debt

Техдолг после M1 вынесен отдельно, чтобы не смешивать стабилизацию кодовой базы с будущими функциональными milestone.

### Code Structure

- ~~`apps/api/src/server.js` все еще содержит крупные handler-группы и SQL-heavy business operations~~ — закрыто Phase 3: SQL вынесен в `modules/<context>/repository.js`, чистые правила в `packages/domain`, handlers в `modules/<context>/controller.js`. `server.js` — 65 строк bootstrap.
- ~~`apps/admin-web/src/server.js` все еще содержит большую часть HTML render-функций и POST handlers~~ — закрыто Task 19: renderers разнесены по `pages/` и `components/`, data-fetching — в `http/routes/`, `server.js` — 17 строк bootstrap. HTML остался байт-в-байт прежним.
- `bot-adapter` пока остается отдельным adapter entrypoint без полноценной декомпозиции сценариев —
  это сознательно: фаза Yandex Messenger отложена, и сервис даже не входит в стек.
- ~~Нет полноценного тестового harness с PostgreSQL fixture data~~ — закрыто: `packages/db/testing/harness.js`
  (схема на отдельной scratch-схеме + сиды + очистка), `apps/api/testing/{boot-api,fixtures}.js`,
  288 интеграционных тестов и 122 golden-снапшота. `smoke:m1` остался как проверка старта, а не инвариантов.

### Runtime And Deployment

- ~~Постоянный staging/test ландшафт на OMV с отдельными volumes, ports и smoke-командой после redeploy~~ — сделано: стенд `192.168.0.100`, порты `3330`/`3340`, `npm run smoke:stand`.
- Проект `parkingassistant` в Arcane с GitOps-привязкой остаётся зарегистрированным, но нерабочим:
  его `redeploy` запустит сборку, которой нечем собирать, и погасит работающие контейнеры. Его надо
  удалить или отвязать в UI — см. [ADR 005](adr/005-stand-deploy-via-host-checkout.md).
- В `staging/env/app.env` на стенде лежат значения `change-me` (`JWT_SECRET`, `SESSION_SECRET`,
  пароль Postgres), а Postgres стенда опубликован на хостовый `5432`. Для стенда приемлемо, для
  прода — нет; закрывается в M9.
- `npm audit --omit=dev` показывает `xlsx` high severity advisories, npm сообщает `No fix available`. Риск принят для текущего offline import tooling: Excel-файлы считаются доверенными, import scripts не являются публичным web upload/runtime endpoint. Если импорт станет пользовательским или регулярным production-процессом, нужно заменить Excel dependency или вынести import tooling из основного runtime.

### Product Gaps

- Авторизация и роли не включены в runtime: админка открыта, расчёт на одного оператора.
  Схема (`auth_users`, `auth_roles`, `auth_sessions`) есть, но ничего её не проверяет — M7.
- Yandex Messenger и сценарии бота не реализованы — M8.
- Визуальный слой admin-web — ad-hoc CSS одним инлайновым блоком; переход на дизайн-систему — M10.
- Нет структурных логов с correlation id, OpenAPI-описаний (`docs/api/` пуст) и описания формата
  Excel-каталога (`docs/catalog/` пуст).
- **Перемещение между местами не является отдельным действием** (техдолг, не горячий): таблица
  `parking_movements` пишется и история в UI показывается, но «перевести сотрудника на другое
  место» делается как отмена плюс новое назначение. Для оператора это два шага, а в истории — два
  события вместо одного перемещения, из-за чего разбор спорной ситуации теряет причинную связь.

## Milestone Plan

### M1. Codebase Stabilization

Цель: подготовить код к безопасному расширению.

Status: completed and validated on OMV via Portainer Git redeploy on 2026-06-13. Portainer has
since been removed from the server; деплой стенда описан в [ADR 005](adr/005-stand-deploy-via-host-checkout.md).

- Разделить `apps/api/src/server.js` на router, repositories, services и serializers: done for first stabilization layer; handler extraction remains tracked as technical debt.
- Разделить `apps/admin-web/src/server.js` на render modules по вкладкам: done for render module selection; полная декомпозиция файла завершена в Task 19.
- Вынести общие helpers для дат, HTML, HTTP, ошибок и статусов: done.
- Ввести единый формат API-ошибки `{ error, code, details }`: done, old fields are preserved for compatibility.
- Обновить README/TASKS под фактический статус: done.

Acceptance:

- URL и поведение существующих endpoints не меняются: validated by preserving handlers and adding `smoke:m1`.
- `node --check` проходит для всех JS entrypoints: `npm run check`.
- Локальный smoke проходит: `npm run smoke:m1`.
- Деплой через Portainer Git redeploy работает без ручного копирования файлов: validated on OMV on 2026-06-13. Portainer auto-update pulled Git, skipped pull for build-only services, rebuilt `api`, `admin-web`, `bot-adapter`, `jobs`, recreated the stack, and API/admin health checks passed.

### M2. Operational Admin UI

Цель: сделать `День` основным рабочим экраном администратора.

- Доработать карточку места: владелец, статус, отдача, назначение, линия, история: done for day operations baseline.
- Добавить быстрые операции из карточки: назначить сотрудника, назначить гостя, отменить назначение, создать отдачу: done for current backend-supported operations.
- Улучшить KPI, легенду карты и фильтры по этажу/статусу/типу: done for map legend and floor/status/type filters; KPI can still be expanded with more operational aggregates.
- Показывать API warnings после ручных и гостевых назначений: done.
- Улучшить вкладку `Заявки`: отдельные таблицы сотрудников, гостей и очереди с причинами статусов: done.

Acceptance:

- Полный дневной сценарий выполняется без SQL: done for release/manual assign/guest create/cancel reservation from `День`.
- Клик по месту на карте открывает карточку места: done.
- Ошибки и предупреждения API видны в UI: done.

### M3. Catalog, History, Audit

Цель: дать администратору полный контроль без прямого доступа к БД.

- Доработать CRUD сотрудников и мест: done.
- Доработать управление постоянными закреплениями: done for create, list/filter and end operations.
- Расширить историю места и сотрудника: done for current operational events.
- Улучшить audit filters по дате, action, entity type и actor: done.
- Добавить отображение последнего успешного запуска каждого job: done.

Acceptance:

- Любое создание, отмена, назначение и изменение справочника видно в audit/history: done for implemented admin operations.
- История открывается из рабочих экранов: done.
- Jobs имеют понятный операционный статус: done for latest successful run summary and recent runs.

### M4. Maps → Place inventory

Цель: дать оператору управление составом парковки.

Status: superseded. Исходный M4 («редактор кликабельных зон на плане этажа») был
реализован и затем **снят целиком**: рисование прямоугольников оказалось неудобным,
геометрия не несла бизнес-смысла, а реальная задача оператора — управлять тем,
сколько мест какой формы существует, а не тем, где лежат пиксели. Замена описана
в разделе `Place inventory` ниже.

- Подложки этажей `G3/G4/G5` с version/checksum: done, сохранено без изменений.
- План этажа — статичная картинка-ориентир: done.
- Инвентарь элементов (линии на 1–3 слота) во вкладке `Места`: done.
- Диагностика: место без линии, расхождение `capacity` и числа слотов: done.

Acceptance:

- План этажа и список элементов под ним описывают один и тот же этаж: done.
- Добавление и архивирование элемента меняет системные счётчики (dashboard,
  availability, гостевой резерв, ёмкость очереди): done, покрыто интеграционными тестами.
- Состав инвентаря меняется только во вкладке `Места`: done.

### M5. Business Rules And Tests

Цель: зафиксировать правила парковки автоматическими проверками.

- Вынести расчет availability в отдельный service.
- Формализовать резерв гостей `5`.
- Зафиксировать приоритет гостей `single -> double -> triple`.
- Проверить приоритет ручных назначений над очередью.
- Добавить API e2e checks через `node:test` или минимальный Node runner.

Acceptance:

- Есть команда для запуска интеграционных проверок.
- Тесты покрывают отдачу, очередь, гостя, ручное назначение, отмену, audit/history.
- Нарушения инвариантов возвращают понятную ошибку.

### M6. Lines And Departures

Цель: закрыть операционную логику multi-линий.

- Доработать экран `Линии` как визуальную структуру позиций `1/2/3`.
- Улучшить фиксацию позиции и валидацию занятости.
- Группировать ранние выезды по линиям.
- Показывать конфликты рядом с назначениями.
- Улучшить contact access logs.

Acceptance:

- Одна позиция линии не может быть занята двумя машинами.
- Админ видит, кто кого блокирует.
- Гости не раскрывают прямые контакты сотрудникам.

### M7. Auth And RBAC

Цель: перейти от single-user admin к production access control.

- Реализовать login/logout/session.
- Подключить роли `system_admin` и `parking_admin`.
- Закрыть admin endpoints авторизацией.
- Добавить UI управления web-пользователями.
- Логировать login, failed login, logout, create/disable user и role changes.

Acceptance:

- Admin web недоступен без логина.
- `parking_admin` управляет парковкой, но не web-доступами.
- `system_admin` управляет пользователями и ролями.

### M8. Yandex Messenger Bot

Цель: вынести сотруднические сценарии в бот.

Если M11 делается раньше, бот становится **вторым каналом** к тем же эндпоинтам, а не
единственным: сценарии и правила к этому моменту уже закрыты, и остаётся только транспорт —
webhook, маппинг messenger-идентификатора на пользователя и формулировки ответов.

- Подключить реальные webhook endpoints.
- Валидировать входящие запросы через signing secret.
- Использовать `yandex_messenger_user_id -> users`.
- Реализовать команды сотрудника через backend API.
- Добавить webhook fixtures и негативные сценарии.

Acceptance:

- Неизвестный messenger user получает понятную ошибку.
- Bot-adapter не содержит бизнес-правил парковки.
- Все действия бота логируются.

### M9. Production Hardening

Цель: сделать эксплуатацию предсказуемой.

- ~~Зафиксировать единственный штатный деплой~~ — сделано: `scripts/deploy/stand.sh` из чекаута
  на хосте, [ADR 005](adr/005-stand-deploy-via-host-checkout.md).
- ~~Добавить health/readiness checks для сервисов~~ — сделано: container healthcheck у `api` и
  `admin-web`, `depends_on: service_healthy` у зависимых сервисов.
- ~~Добавить smoke-check checklist после redeploy~~ — сделано: `npm run smoke:stand`.
- Описать backup/restore для PostgreSQL и mounted storage.
- Усилить production env defaults и secrets: сейчас в `staging/env/app.env` лежат значения
  `change-me`, а Postgres стенда опубликован на хостовый `5432`.
- Перевести стенд на образы из registry, если ручной запуск скрипта деплоя станет узким местом
  (отвергнутая на сегодня альтернатива из ADR 005).

Acceptance:

- Новый релиз поднимается одной командой из git: done.
- Есть короткий проверочный чеклист после релиза: done.
- Есть документированный минимум backup/restore.
- В env стенда нет значений `change-me`.

### M10. Design System Migration (Vision UI)

Цель: перевести `admin-web` на дизайн-систему **Vision UI** ВсеИнструменты
(`@vi-frontend/vision-ui`).

Источник истины о компонентах — MCP-сервер `https://design-system.vseinstrumenti.net/mcp`
(инструменты `list_components`, `search_components`, `get_component`, `get_story`). Работу ведёт
скилл `vi-design` (установлен в dev-контейнере, `~/.claude/skills/vi-design`): он читает компонент
через MCP и выдаёт Vue 3 SFC плюс самодостаточное HTML-превью для согласования с заказчиком.
Жёсткое правило скилла — пропсы и события **не выдумываются**: компонент, попавший в код, должен
быть предварительно прочитан через MCP.

#### Два ограничения, которые надо снять до начала работ

**1. MCP-сервер недоступен из текущей инфраструктуры.** `design-system.vseinstrumenti.net` не
резолвится публично (`NXDOMAIN` с `8.8.8.8`): зона `vseinstrumenti.net` обслуживается
собственными NS и видна только из корпоративной сети. Ни dev-контейнер, ни сервер OMV до неё не
достают. Варианты: корпоративный VPN/DNS на машине, где идёт работа; выгрузка документации
(`scripts/vi-design-mcp.sh list` / `get`) с машины с доступом; либо туннель/прокси — скрипт
скилла принимает адрес через `VISION_UI_MCP_URL`. Пока доступа нет, скилл по собственному правилу
обязан останавливаться, а не писать код по памяти.

**2. Внутренний npm-реестр ломает сборку стенда.** `@vi-frontend/vision-ui` живёт во внутреннем
реестре, а образы стенда собираются **на самом OMV** (см. [ADR 005](adr/005-stand-deploy-via-host-checkout.md)),
у которого корпоративного доступа нет. Если `admin-web` начнёт зависеть от пакета, его образ там
перестанет собираться. Выходы: вендорить собранный бандл в репозиторий, перенести сборку
`admin-web` в корпоративный CI и тянуть готовый образ из registry (это как раз вариант A из
ADR 005), либо не вводить npm-зависимость вовсе — см. маршрут Б ниже.

#### Статус

Решение принято: **маршрут А**, Vue 3 на настоящих компонентах ДС. Зафиксировано в
[ADR 006](adr/006-admin-ui-on-vision-ui.md), оба ограничения выше сняты — ДС есть локально
(зеркало документации + MCP), пакеты пришли тарболами в `vendor/`.

Сделано: приложение `apps/admin-ui` (Vue 3 + Vite), сервер статики с прокси `/api`, вкладка
**День** целиком — дата, KPI, фильтры, список элементов со слотами, операционная карточка места
со всеми пятью операциями, таблицы дня. 33 теста на vitest + happy-dom (`npm run test:ui`),
сервис `admin-ui` в compose на порту `3360`.

Осталось: вкладки `Заявки`, `Линии`, `Справочники`, `Журнал`, `Места` и удаление `admin-web`
последней задачей. План — `docs/plans/20261009-admin-ui-vision-migration.md`.

#### Решение, которое было принято в начале milestone

Нынешний `admin-web` — SSR на голом `node:http`, без фреймворка, без build step и без единой
сторонней зависимости; его образ собирается вообще без `node_modules`. Vision UI — библиотека
Vue 3. Поэтому миграция это не «поменять CSS», а выбор одного из двух:

**Маршрут А — переписать `admin-web` как Vue 3 SPA на Vision UI.** Настоящие компоненты ДС,
никакого расхождения с ней. Цена: уходит свойство «нет build step», появляется зависимость от
внутреннего реестра (и ограничение 2 выше), переписываются все шесть вкладок, все формы и вместе
с ними `tabs.test.js`, `pages.test.js` и селекторы `testing/page-model.js`. API не меняется.

**Маршрут Б — оставить SSR и перенести из ДС токены и плоские классы.** Скилл поставляется с
`references/tokens.md` (цвета RGB-триплетами, типографика, отступы, радиусы сборки 1.15.1) и
`assets/vision-ui-preview.css` — самодостаточной CSS-реализацией классов `vi-button`, `vi-input`,
`vi-card`, `vi-title-h2`. Это работает офлайн, без реестра и без Vue, и ломает ровно столько,
сколько ломает смена стилей. Цена названа в самом скилле честно: превью-CSS — **приближение**
для согласования, а не библиотека, и со временем разойдётся с настоящей ДС.

Промежуточный шаг, полезный при любом выборе: собрать скиллом HTML-превью двух-трёх ключевых
экранов (`День`, `Места`) и согласовать внешний вид **до** того, как трогать код.

#### Что остаётся верным при любом маршруте

- статус места несёт смысл цветом **и** словом — это контракт доступности для дальтоников,
  а не косметика;
- слоты остаются настоящими `<button aria-pressed>` с клавиатурной навигацией;
- `tabs.test.js`, `pages.test.js` и `testing/page-model.js` проверяют фактическую разметку,
  поэтому обновляются осознанно, а не перегенерацией;
- порядок работ — токены, затем примитивы, затем экраны: `День` → `Места` → `Заявки` → `Линии` →
  `Справочники` → `Журнал`, по коммиту на компонент.

Acceptance:

- маршрут (А или Б) зафиксирован отдельным ADR вместе с последствиями для сборки стенда;
- ни один экран не держит собственных инлайновых стилей вне общего слоя;
- `npm run check && npm run lint && npm test` зелёные, разметочные тесты обновлены осознанно;
- статусы мест читаются без цвета, клавиатурная навигация по слотам не потеряна;
- на стенде все вкладки рендерятся в новом виде, `npm run smoke:stand` зелёный.

### M11. Employee Self-Service Web UI

Цель: отдать сотруднику его собственные сценарии, **не дожидаясь мессенджера**.

Сегодня у сотрудника нет никакого интерфейса, поэтому администратор вводит за него отдачи,
заявки, время выезда и позиции в линии. Логика это позволяет — все эти операции есть в admin UI, —
но в журнале всё приписано оператору, и поле «кто инициировал» перестаёт различать сотрудника и
администратора. Отдельный веб-интерфейс закрывает это раньше и дешевле, чем интеграция с
Yandex Messenger.

Объём — ровно те сценарии, что README перечисляет для сотрудников:

- отдать закреплённое место на день или диапазон, посмотреть и отменить будущие отдачи;
- запросить место на завтра, посмотреть свою заявку или назначение, отменить заявку;
- создать гостевую заявку;
- указать время выезда на завтра (до `07:00` дня выезда);
- зафиксировать свою позицию в линии и посмотреть структуру линии;
- получить контакты впередистоящих (с отдельным текстом, если впереди гость).

Принципы:

- бизнес-правил в этом UI нет вообще: он ходит в тот же `api`, что и admin-web, и ничего не решает
  сам — иначе появится второй источник истины для правил `19:00`/`07:00` и гостевого резерва;
- API для всех шести сценариев **уже есть** (`/bot/*` и соответствующие admin-эндпоинты), поэтому
  milestone почти целиком про UI и идентификацию;
- отдельный deployable unit (`apps/employee-web`) против новой роли внутри `admin-web` — решается
  в начале milestone и фиксируется ADR: от этого зависит, как раскладываются порты и reverse proxy.

**Зависимость, которую нельзя обойти: сотрудника надо опознать.** «Своё место» и «своя заявка» не
имеют смысла без идентичности, поэтому M11 требует хотя бы аутентификации сотрудников — то есть
опирается на M7, а не идёт параллельно ему. Самый дешёвый вариант (вход по ссылке-токену без
пароля) тоже стоит рассматривать как часть M7, а не как обход.

Acceptance:

- сотрудник выполняет все шесть сценариев без участия администратора;
- в `audit_logs` и `reservation_events` действие сотрудника отличимо от действия оператора;
- ни одно парковочное правило не дублируется вне `api` (проверяется теми же boundary-тестами);
- админка продолжает уметь всё то же самое за сотрудника — это остаётся штатным резервным путём.

### M12. Excel-каталог из UI

Цель: убрать shell из пути оператора. Низкий приоритет.

Сейчас каталог мест и постоянные закрепления заводятся только командами
`npm run db:import:parking-catalog` и `npm run db:import:permanent-assignments`, то есть первичное
наполнение и любое обновление требуют доступа к серверу. Загрузка `.xlsx` прямо во вкладке
`Справочники` или `Места` закрывает единственный оставшийся сценарий, где оператору нужна консоль.

- форма загрузки файла (механика `multipart` уже есть — на ней работает замена подложки этажа);
- предпросмотр перед применением: сколько мест создастся, сколько обновится, что не распознано;
- повторный импорт не теряет уже созданные связи — это свойство текущих скриптов, и его надо
  сохранить, а не переписать;
- `xlsx` остаётся в офлайн-пути: если файл начнёт приходить от пользователя через web, надо
  пересмотреть зависимость (см. Technical Debt → Runtime And Deployment).

Acceptance:

- оператор заводит каталог с нуля и обновляет его, не открывая терминал;
- повторная загрузка того же файла ничего не ломает и не дублирует;
- результат импорта виден в audit log.

## Verification Checklist

Локальные проверки перед push:

```bash
npm run check   # парсит каждый .js в репозитории
npm run lint
npm test
git diff --check
```

Smoke-check после деплоя:

```bash
npm run smoke:stand
```

Команда проверяет семь точек: `3330/health`, `3330/health/db`, `3340/health`, рендер
`3340/?view=day`, `3360/health`, оболочку SPA на `3360/` и прокси `3360/api/health`,
печатает построчный отчёт и завершается с ненулевым кодом при первом же провале.

Диагностика на сервере (из dev-контейнера; своего docker-демона у него нет):

```bash
arcane ps                                   # контейнеры сервера
arcane logs parkingassistant-api 100
arcane logs parkingassistant-admin-web 100
arcane logs parkingassistant-jobs 100

ssh omv docker ps --filter name=parkingassistant
ssh omv docker logs --tail 100 parkingassistant-migrate
```

## Known Gaps

- Auth/RBAC еще не включены в runtime как обязательный доступ (схема есть, проверок нет).
- Yandex Messenger integration требует production webhook validation.
- CI (`.github/workflows/ci.yml`) гоняет `check`, `lint` и `npm test`, но **не** интеграционные
  тесты: им нужен живой PostgreSQL, и поднимать его в CI пока не настроено. Поэтому `npm run
  test:integration` остаётся ручным шагом перед заметными изменениями схемы или бизнес-правил.
- Backup/restore для PostgreSQL и mounted storage не формализован (health/readiness — сделаны).
- Деплой стенда запускается вручную (`scripts/deploy/stand.sh`), автоматического триггера по
  push в `main` нет — осознанный компромисс варианта из ADR 005.
