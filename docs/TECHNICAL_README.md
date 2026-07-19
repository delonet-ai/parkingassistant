# Technical README

Актуальная техническая точка входа для разработки Parking Assistant.

Документ фиксирует фактическую архитектуру, текущий runtime, основные зоны кода, правила деплоя и дальнейший milestone-план. Детальные документы остаются отдельными источниками:

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
- map zones для кликабельных карт;
- job runs и ручной запуск jobs.

Что уже есть в admin UI:

- вкладка `День`: дата, KPI, операционная карта, карточка места и дневные таблицы;
- вкладка `Заявки`: заявки сотрудников, гости, очередь и обработка;
- вкладка `Линии`: позиции, выезды, конфликты и contact logs;
- вкладка `Справочники`: сотрудники, места, постоянные закрепления, истории;
- вкладка `Журнал`: audit logs, contact logs, jobs;
- вкладка `Карта`: технический редактор зон и разметки.

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

- `apps/api/src/server.js`: backend entrypoint, wiring сервера и текущий основной набор API handlers.
- `apps/api/src/router.js`: активный HTTP router для backend API.
- `apps/api/src/repositories`: первый слой repository modules.
- `apps/api/src/services`: первый слой service modules.
- `apps/api/src/serializers`: первый слой response serializers.
- `apps/admin-web/src/server.js`: admin UI entrypoint и текущий основной набор render/POST handlers.
- `apps/admin-web/src/render-modules.js`: выбор render-модуля по вкладке admin UI.
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
- `parking_place_maps` и `parking_place_map_zones`: карты этажей и кликабельные зоны;
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

- `День`: ежедневная операционная работа. Карта read-only по геометрии, но места кликабельны для операций.
- `Заявки`: очередь сотрудников, гостевые заявки, создание и отмена заявок, ручная обработка.
- `Линии`: multi-линии, позиции, ранние выезды, конфликты и доступ к контактам.
- `Справочники`: сотрудники, места, постоянные закрепления, истории места и сотрудника.
- `Журнал`: audit log, contact access logs, jobs/runs.
- `Карта`: технический редактор подложек и зон.

Принцип: экран `День` не должен позволять менять геометрию карты или типы зон. Все технические действия с картами остаются во вкладке `Карта`.

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

## Technical Debt

Техдолг после M1 вынесен отдельно, чтобы не смешивать стабилизацию кодовой базы с будущими функциональными milestone.

### Code Structure

- `apps/api/src/server.js` все еще содержит крупные handler-группы и SQL-heavy business operations. Router, первый repository/service/serializer слой и shared helpers уже вынесены, но handlers нужно дальше переносить по доменным модулям.
- `apps/admin-web/src/server.js` все еще содержит большую часть HTML render-функций и POST handlers. Render selection вынесен в `render-modules.js`, но сами вкладки нужно переносить в отдельные files/modules.
- `bot-adapter` пока остается отдельным adapter entrypoint без полноценной декомпозиции сценариев.
- Нет полноценного тестового harness с PostgreSQL fixture data; `smoke:m1` проверяет старт и базовые HTTP paths, но не бизнес-инварианты.

### Runtime And Deployment

- Для независимости от локального Mac нужен постоянный staging/test ландшафт на OMV с отдельными volumes, ports и smoke-командой после redeploy.
- `npm audit --omit=dev` показывает `xlsx` high severity advisories, npm сообщает `No fix available`. Риск принят для текущего offline import tooling: Excel-файлы считаются доверенными, import scripts не являются публичным web upload/runtime endpoint. Если импорт станет пользовательским или регулярным production-процессом, нужно заменить Excel dependency или вынести import tooling из основного runtime.

### Product Gaps

- M2 UI операции в карточке места еще не доведены до полного дневного сценария без SQL.
- Интеграционные проверки бизнес-правил остаются задачей M5.

## Milestone Plan

### M1. Codebase Stabilization

Цель: подготовить код к безопасному расширению.

Status: completed and validated on OMV via Portainer Git redeploy on 2026-06-13.

- Разделить `apps/api/src/server.js` на router, repositories, services и serializers: done for first stabilization layer; handler extraction remains tracked as technical debt.
- Разделить `apps/admin-web/src/server.js` на render modules по вкладкам: done for render module selection; full file extraction remains tracked as technical debt.
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

### M4. Maps

Цель: сделать карты надежным техническим инструментом.

Status: completed and validated on OMV via Portainer Git redeploy on 2026-06-13.

- Завершить редактор зон во вкладке `Карта`: done for draw, update type and delete flows.
- Добавить диагностику: зона без места, место без зоны, неактивное место с активной зоной: done.
- Реализовать загрузку и замену подложек по `G3/G4/G5`: done.
- Сохранять version/checksum подложек: done.

Acceptance:

- SVG-зоны не смещаются при изменении размера окна: done by normalized geometry and SVG viewBox overlay.
- Геометрия редактируется только во вкладке `Карта`: done.
- После замены подложки связи зон с местами сохраняются: done; validated by replacing the G4 background with the same file, updating version/checksum while keeping existing zones.

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
node --check apps/api/src/server.js
node --check apps/admin-web/src/server.js
node --check apps/bot-adapter/src/server.js
node --check apps/jobs/src/scheduler.js
git diff --check
```

Smoke-check после Portainer redeploy:

```bash
curl -fsS http://192.168.0.100:3330/health
curl -fsS http://192.168.0.100:3340/health
curl -fsS "http://192.168.0.100:3340/?view=day"
curl -fsS "http://192.168.0.100:3340/?view=maps"
```

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
