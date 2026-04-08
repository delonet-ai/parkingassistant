# Tasks By Modules

Ниже стартовая декомпозиция задач по файлам и модулям. Это не финальная структура фреймворка, а рабочий blueprint, чтобы можно было быстро начать реализацию.

## Предлагаемая структура репозитория

```text
apps/
  api/
  admin-web/
  bot-adapter/
packages/
  domain/
  db/
  jobs/
  shared/
docs/
  api/
  adr/
infra/
```

## apps/api

### `apps/api/src/modules/users`

- CRUD и поиск сотрудников
- роли: администратор, сотрудник
- хранение контактов для экстренной связи
- привязка сотрудников к данным для `Yandex Messenger`

### `apps/api/src/modules/vehicles`

- машины сотрудников
- связь с владельцем
- признак основной машины

### `apps/api/src/modules/parking-places`

- справочник мест
- тип места: `single`, `double`, `triple`
- признак гостевого приоритета
- связь с `line_group`
- координаты или привязка к зоне на карте
- связь с импортом из Excel-каталога

### `apps/api/src/modules/line-groups`

- группы линий на 2 или 3 места
- конфигурация порядка позиций
- получение цепочки "кто перед кем"

### `apps/api/src/modules/permanent-assignments`

- закрепление постоянного места за сотрудником
- история изменения закреплений
- валидации пересечений

### `apps/api/src/modules/place-releases`

- отдача закрепленного места на дату или диапазон
- отмена будущих отдач
- запрет возврата следующего дня после `19:00`, если день уже зафиксирован

### `apps/api/src/modules/employee-requests`

- заявка сотрудника без постоянного места
- одна активная заявка на дату
- отмена заявки
- перевод в очередь

### `apps/api/src/modules/guest-requests`

- создание гостя через сотрудника или администратора
- хранение приглашающего сотрудника
- подготовка к назначению места без очереди

### `apps/api/src/modules/reservations`

- фактическое назначение места на дату
- источник назначения: auto, manual, guest, queue
- защита от двойного назначения
- отмена и переназначение
- сохранение причины и инициатора назначения

### `apps/api/src/modules/reservation-history`

- история всех назначений по местам и пользователям
- кто назначил: администратор, система, очередь, бот
- что изменилось: created, moved, canceled, reassigned
- построение ленты событий по месту и по пользователю

### `apps/api/src/modules/parking-movements`

- перемещение пользователя между местами
- перенос с одного места на другое с полной трассировкой
- различение ручного и автоматического перемещения

### `apps/api/src/modules/queue`

- очередь на конкретную дату
- порядок выдачи
- исключение вручную назначенных пользователей
- состояние обработки в начале дня

### `apps/api/src/modules/departure-plans`

- время выезда на завтра
- дедлайн редактирования до `07:00`
- валидация, что значение важно только раньше `18:00`

### `apps/api/src/modules/line-occupancy`

- фиксация фактической позиции в линии
- уникальность позиции на дату
- определение пользователей впереди

### `apps/api/src/modules/contact-access`

- выдача контактов впередистоящих
- спец-обработка случая, когда впереди гость
- логирование всех запросов доступа к контактам

### `apps/api/src/modules/conflicts`

- расчет конфликтов по раннему выезду
- предупреждение при назначении гостя перед сотрудником
- список конфликтов для админки

### `apps/api/src/modules/audit`

- audit log всех критичных действий
- actor, action, entity, payload, timestamp
- фильтрация для web UI
- отдельные события по созданию, удалению и переназначению пользователей
- отдельные события по ручному и автоматическому назначению мест

### `apps/api/src/modules/scheduling`

- правила доступности мест до `19:00` и после `19:00`
- расчет доступного пула для сотрудников и гостей
- контроль резерва в `5` гостевых мест

### `apps/api/src/modules/auth`

- логин в web UI
- авторизация администратора парковки в web UI
- service-to-service аутентификация bot adapter -> backend
- маппинг внешнего идентификатора messenger на пользователя
- хранение логинов, паролей и статусов доступа

### `apps/api/src/modules/access-control`

- роли `system_admin` и `parking_admin`
- права на создание пользователей и управление ролями
- guard-ы и permission checks для API

### `apps/api/src/modules/admin-users`

- создание пользователей web UI
- блокировка, удаление, сброс пароля
- просмотр логинов и ролей
- журнал действий по учетным записям

### `apps/api/src/modules/admin-dashboard`

- агрегаты для экранов "сегодня" и "завтра"
- парковка, очередь, конфликты, ранние выезды
- история ручных и автоматических назначений

### `apps/api/src/modules/floor-maps`

- хранение схем этажей
- хранение кликабельных зон мест
- выдача карты и слоев занятости для web UI

### `apps/api/src/modules/catalog-import`

- импорт парковочных мест из Excel
- сопоставление колонок источника и структуры БД
- валидация дубликатов и пропусков
- повторный импорт без потери уже созданных связей

### `apps/api/src/controllers/bot`

- HTTP endpoints для bot adapter
- стабильные ответы для сценариев бота

### `apps/api/src/controllers/admin`

- HTTP endpoints для админки
- списки, dashboard, ручные назначения, audit log

## apps/admin-web

### `apps/admin-web/src/pages/dashboard`

- экран на сегодня и завтра
- карточки занятости
- виджеты конфликтов, очереди, ранних выездов
- блок последних ручных и автоматических назначений

### `apps/admin-web/src/pages/places`

- список мест
- фильтры по типу и линии
- статус доступности
- переход к месту на карте

### `apps/admin-web/src/pages/map`

- карта этажей
- выбор места кликом по схеме
- подсветка занятых, свободных, guest-priority и multi-мест
- отображение конфликтов и ранних выездов поверх карты

### `apps/admin-web/src/pages/assignments`

- постоянные закрепления
- ручные назначения
- быстрые действия для администратора
- история назначений и перемещений

### `apps/admin-web/src/pages/guests`

- создание гостя
- привязка к приглашающему
- назначение места с предупреждениями

### `apps/admin-web/src/pages/queue`

- очередь на дату
- статус автообработки
- исключения из очереди после ручного назначения

### `apps/admin-web/src/pages/lines`

- схема multi-линий
- фактические позиции
- пользователи впереди и позади

### `apps/admin-web/src/pages/audit`

- журнал действий
- фильтры по actor, entity, дате, типу операции

### `apps/admin-web/src/pages/users`

- логины пользователей web UI
- создание и блокировка пользователей
- назначение ролей
- просмотр действий по учетным записям

### `apps/admin-web/src/components`

- таблицы
- формы
- баннеры конфликтов
- статусные бейджи
- таймлайн событий
- карта парковки с интерактивными зонами

## apps/bot-adapter

### `apps/bot-adapter/src/messenger`

- входящие webhook events из `Yandex Messenger`
- отправка ответов пользователям
- верификация подписи или токена, если требуется платформой

### `apps/bot-adapter/src/scenarios/release-place`

- отдать место на день
- отдать место на диапазон
- показать подтверждение и ошибки

### `apps/bot-adapter/src/scenarios/request-parking`

- запрос парковки на завтра
- просмотр текущей заявки или назначения
- отмена заявки

### `apps/bot-adapter/src/scenarios/guest-request`

- создание гостевой заявки через сотрудника

### `apps/bot-adapter/src/scenarios/departure-plan`

- указание времени выезда на завтра

### `apps/bot-adapter/src/scenarios/line-position`

- фиксация позиции `1/2/3`
- получение структуры линии

### `apps/bot-adapter/src/scenarios/blocking-contacts`

- запрос контактов впередистоящих
- отдельный текст, если впереди гость

### `apps/bot-adapter/src/api-client`

- единый клиент backend API
- маппинг backend errors в понятные сообщения для бота

## packages/domain

### `packages/domain/src/entities`

- сущности домена
- enums и value objects

### `packages/domain/src/services`

- правила назначения
- гостевой резерв
- очередь
- ранние выезды
- multi-линии
- история изменений назначения
- правила ручного и автоматического перемещения

### `packages/domain/src/policies`

- политика доступа мест до и после `19:00`
- политика отмены отдач
- политика редактирования времени выезда

## packages/db

### `packages/db/schema`

- SQL migrations
- индексы
- уникальные ограничения
- внешние ключи
- таблицы авторизации и ролей
- таблицы карт этажей и зон
- таблицы истории назначений и перемещений

### `packages/db/seeds`

- сиды пользователей
- сид базового `system_admin`
- сид тестовых `parking_admin`
- сиды мест
- сиды line groups
- сиды постоянных закреплений

### `packages/db/repositories`

- репозитории для всех ключевых сущностей
- транзакционные операции назначения и очереди
- транзакционные операции перемещения между местами
- репозитории для auth и access control

## packages/jobs

### `packages/jobs/src/jobs/freeze-next-day`

- задача после `19:00`
- фиксация следующего дня по отданным местам

### `packages/jobs/src/jobs/unlock-employee-pool`

- раскрытие доступности мест после `19:00`
- проверка гостевого резерва

### `packages/jobs/src/jobs/lock-departure-edit`

- задача после `07:00`
- блокировка изменения времени выезда на текущий день

### `packages/jobs/src/jobs/process-queue`

- задача на начало дня
- обработка очереди
- пропуск вручную назначенных пользователей

### `packages/jobs/src/jobs/rebuild-conflicts`

- пересчет конфликтов и уведомлений

## packages/shared

### `packages/shared/src/contracts`

- DTO для bot API
- DTO для admin API
- DTO для system admin API
- единые коды ошибок

### `packages/shared/src/time`

- timezone helpers
- правила сравнения дат "сегодня/завтра"
- cut-off логика `19:00` и `07:00`

### `packages/shared/src/logging`

- структурные логи
- correlation id

## docs

### `docs/api`

- OpenAPI или markdown-описание Bot API
- OpenAPI или markdown-описание Admin API
- OpenAPI или markdown-описание System Admin API

### `docs/adr`

- выбор стека backend
- выбор стека admin UI
- стратегия интеграции с `Yandex Messenger`
- timezone strategy
- стратегия хранения карты этажей и кликабельных зон
- стратегия импорта Excel-каталога
- стратегия auth и RBAC

### `docs/catalog`

- описание формата Excel-каталога парковочных мест
- правила маппинга полей в `parking_places`
- правила ручной донастройки line groups и карты зон

## infra

### `infra/docker`

- локальный `docker-compose` для API, PostgreSQL и вспомогательных сервисов
- multi-stage Dockerfile для `api`, `bot-adapter`, `jobs`
- отдельный Dockerfile для `admin-web`

### `infra/deploy`

- переменные окружения
- шаблоны деплоя
- настройки scheduler
- reverse proxy config
- secret management
- persistent storage для карт и импортов

## Порядок реализации

### 1. Foundation

- `packages/shared`
- `packages/domain`
- `packages/db/schema`
- `apps/api` базовый каркас

### 2. MVP backend

- пользователи, места, линии, закрепления
- auth, access control, admin users
- импорт каталога мест
- отдача мест
- заявки сотрудников
- гостевые заявки
- reservations
- очередь
- история назначений

### 3. Каналы

- `apps/bot-adapter`
- `apps/admin-web`
- экран карты этажей
- экран пользователей web UI

### 4. Ограничения и конфликты

- reserve policy
- line occupancy
- departure plans
- conflicts

### 5. Операционная надежность

- jobs
- audit log
- интеграционные тесты

## Что можно сделать следующим шагом

- выбрать стек
- создать monorepo-структуру
- описать ERD
- набросать OpenAPI
- поднять первый backend skeleton
