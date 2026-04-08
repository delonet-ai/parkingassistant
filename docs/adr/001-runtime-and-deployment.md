# ADR 001: Runtime and Deployment Baseline

## Status

Accepted

## Context

Проекту нужен предсказуемый и недорогой в сопровождении baseline для:

- backend API
- admin web UI
- Yandex Messenger bot adapter
- background jobs
- PostgreSQL

Нам важно:

- быстро стартовать разработку
- одинаково запускать проект локально и в production
- не раздувать инфраструктуру раньше времени
- избежать проблем с нативными зависимостями для импорта Excel, карт и PDF

## Decision

Принимаем такой baseline:

- runtime platform: `Node.js 22`
- primary database: `PostgreSQL 16`
- base docker image for app runtimes: `node:22-bookworm-slim`
- deployment shape: separate containers for `admin-web`, `api`, `bot-adapter`, `jobs`
- reverse proxy in front of web and API
- `Redis` не включаем в обязательный MVP

## Rationale

`node:22-bookworm-slim` выбран вместо `alpine`, потому что:

- меньше риск несовместимости нативных пакетов
- проще подключать библиотеки для импорта документов и фоновых задач
- удобнее собирать одинаковые runtime images

Отдельный контейнер `jobs` выбран потому что:

- расписание задач является частью продукта
- задачи на `19:00`, `07:00` и начало дня не должны зависеть от web traffic
- проще масштабировать и контролировать отдельно

Отдельный `bot-adapter` полезен потому что:

- интеграция с `Yandex Messenger` имеет свой жизненный цикл
- webhook traffic и retry semantics лучше изолировать

## Consequences

Плюсы:

- простая операционная модель
- хороший local-to-prod parity
- минимум лишней инфраструктуры
- понятный путь роста

Минусы:

- больше одного application image в деплое
- scheduler пока не опирается на отдельную очередь
- при большом росте нагрузки позже понадобится выделение worker infrastructure

## Revisit Triggers

Пересматриваем решение, если:

- появятся тяжелые async workflows
- потребуется высокая отказоустойчивость scheduler
- понадобится интенсивная обработка карт или документов
- бот начнет давать существенно другой профиль нагрузки, чем основной backend

