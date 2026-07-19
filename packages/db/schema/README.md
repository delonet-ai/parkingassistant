# Database Schema

## Current Baseline

Начальная схема лежит в:

- [001_initial_schema.sql](/Users/deliter/Documents/GitClone/parkingassistant/packages/db/schema/001_initial_schema.sql)
- [002_job_runs.sql](/Users/deliter/Documents/GitClone/parkingassistant/packages/db/schema/002_job_runs.sql)

Это foundation-миграция для:

- web UI auth и RBAC
- справочника сотрудников и машин
- каталога парковочных мест и линий
- карт этажей и кликабельных зон
- постоянных закреплений
- отдач мест, заявок, очереди
- назначений, истории и перемещений
- планов выезда, line occupancy
- contact access logs и audit log
- job runs для ручных/фоновых регламентных запусков

Bootstrap seed:

- [../seeds/001_bootstrap_system_admin.sql](/Users/deliter/Documents/GitClone/parkingassistant/packages/db/seeds/001_bootstrap_system_admin.sql)

## Applying

`npm run db:migrate` (см. `packages/db/migrate.js`) применяет файлы этой папки, затем
`../seeds/*.sql`, в лексикографическом порядке и записывает каждый применённый файл в
`schema_migrations`. Команда идемпотентна — повторный запуск не применяет ничего.

## Migration Strategy

- каждая следующая миграция получает новый префикс `002_`, `003_` и так далее
- destructive changes не правят `001`, а добавляются новыми миграциями
- бизнес-ограничения сначала фиксируются на уровне БД, потом дублируются в application validation
