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

Целевой production-процесс:

```text
local changes
  -> git commit
  -> git push origin main
  -> Portainer Git stack redeploy
  -> smoke checks
```

Важно:

- Portainer должен сам забирать актуальный код из Git.
- Ручной `scp` файлов на сервер не является штатным деплоем.
- SSH на сервер используется только для диагностики логов, health checks и аварийного анализа.
- В compose не нужно монтировать исходники приложения в `/app`; код должен попадать внутрь image на этапе build.

### Состав стека

`docker-compose.yml` описывает пять сервисов, и только их:

| Сервис | Образ | Роль |
|---|---|---|
| `postgres` | `postgres:16-bookworm` | БД, healthcheck через `pg_isready` |
| `migrate` | `infra/docker/app.Dockerfile` | one-shot `npm run db:migrate`, стартует после healthy `postgres` |
| `api` | `infra/docker/app.Dockerfile` | HTTP API, порт `3330` → 3000 |
| `admin-web` | `infra/docker/admin-web.Dockerfile` | SSR-админка, порт `3340` → 3100 |
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
  -> Portainer Git stack redeploy      # человек или Portainer API, не агент
  -> migrate отрабатывает сам
  -> npm run smoke:stand
```

`npm run smoke:stand` (`scripts/smoke/stand.js`) запускается из dev-контейнера и проверяет
`3330/health`, `3330/health/db`, `3340/health` и рендер `3340/?view=day`. Только чтение —
команда безопасна и против прода. Адрес переопределяется переменными
`SMOKE_STAND_HOST`, `SMOKE_STAND_API_PORT`, `SMOKE_STAND_ADMIN_PORT`, `SMOKE_STAND_TIMEOUT_MS`
(по умолчанию — стенд `192.168.0.100`).

Сам redeploy — человеческий шаг или вызов Portainer API; агент его не выполняет.

### Schema migrations

Схема БД применяется идемпотентной командой `npm run db:migrate`
(`packages/db/migrate.js`): она прогоняет `packages/db/schema/*.sql`, затем
`packages/db/seeds/*.sql` в лексикографическом порядке и фиксирует каждый применённый файл в
таблице-леджере `schema_migrations`. Повторный запуск не применяет ничего.

В стеке это отдельный one-shot сервис `migrate`, который стартует после healthy `postgres` и
завершается до старта `api` и `jobs` (`depends_on: service_completed_successfully`). Отдельного
ручного шага при деплое нет: `push` в `main` → Portainer redeploy → миграция отрабатывает сама.

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
- Admin Web: `3340`;
- Bot Adapter: `3350`.

### Test Stand (staging)

Тестовый стенд для проверки и перекаток:

- Хост: `192.168.0.100`. Полностью под тестирование; на нём через Portainer поднят стек со всеми
  контейнерами и компонентами из `main`.
- Управление Docker на сервере — предпочтительно через **Portainer API** (удобнее, чем ручные
  docker-команды по SSH). Токен Portainer выпускается отдельно и хранится **вне репозитория**
  (например, в переменной окружения `PORTAINER_API_TOKEN` / секрет-хранилище), в git не коммитится.
- Деплой на стенд идёт штатно: `push` в `main` → Portainer Git stack redeploy (см. поток выше).
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
- `bot-adapter` пока остается отдельным adapter entrypoint без полноценной декомпозиции сценариев.
- Нет полноценного тестового harness с PostgreSQL fixture data; `smoke:m1` проверяет старт и базовые HTTP paths, но не бизнес-инварианты.

### Runtime And Deployment

- ~~Постоянный staging/test ландшафт на OMV с отдельными volumes, ports и smoke-командой после redeploy~~ — сделано: стенд `192.168.0.100`, порты `3330`/`3340`, `npm run smoke:stand`.
- `npm audit --omit=dev` показывает `xlsx` high severity advisories, npm сообщает `No fix available`. Риск принят для текущего offline import tooling: Excel-файлы считаются доверенными, import scripts не являются публичным web upload/runtime endpoint. Если импорт станет пользовательским или регулярным production-процессом, нужно заменить Excel dependency или вынести import tooling из основного runtime.

### Product Gaps

- M2 UI операции в карточке места еще не доведены до полного дневного сценария без SQL.
- Интеграционные проверки бизнес-правил остаются задачей M5.

## Milestone Plan

### M1. Codebase Stabilization

Цель: подготовить код к безопасному расширению.

Status: completed and validated on OMV via Portainer Git redeploy on 2026-06-13.

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

- Зафиксировать Git -> Portainer redeploy как единственный штатный деплой.
- Добавить health/readiness checks для сервисов.
- Описать backup/restore для PostgreSQL и mounted storage.
- Добавить smoke-check checklist после redeploy.
- Усилить production env defaults и secrets.

Acceptance:

- Новый релиз поднимается через Portainer из Git.
- Есть короткий проверочный чеклист после релиза.
- Есть документированный минимум backup/restore.

## Verification Checklist

Локальные проверки перед push:

```bash
npm run check   # парсит каждый .js в репозитории
npm run lint
npm test
git diff --check
```

Smoke-check после Portainer redeploy:

```bash
npm run smoke:stand
```

Команда проверяет `3330/health`, `3330/health/db`, `3340/health` и рендер `3340/?view=day`,
печатает построчный отчёт и завершается с ненулевым кодом при первом же провале.

Диагностика на сервере:

```bash
docker ps --filter name=parkingassistant
docker logs --tail 100 parkingassistant-api
docker logs --tail 100 parkingassistant-admin-web
docker logs --tail 100 parkingassistant-jobs
```

## Known Gaps

- Auth/RBAC еще не включены в runtime как обязательный доступ.
- Yandex Messenger integration требует production webhook validation.
- Тестовая инфраструктура пока не является полноценным gate перед релизом.
- `api` и `admin-web` требуют декомпозиции больших entrypoint-файлов.
- Backup/restore и health/readiness нужно формализовать до production эксплуатации.
- README содержит исторические baseline-описания и должен постепенно синхронизироваться с фактическим состоянием.
