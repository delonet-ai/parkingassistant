# Database Schema

## Current Baseline

Начальная схема лежит в:

- [001_initial_schema.sql](./001_initial_schema.sql)
- [002_job_runs.sql](./002_job_runs.sql)
- [003_infer_line_groups.sql](./003_infer_line_groups.sql)
- [004_job_state.sql](./004_job_state.sql) — `departure_plans.locked_at` для 07:00-отсечки;
  `place_releases.frozen_at` (колонка была с 001) начала писаться job-ом `freeze_next_day`
- [005_place_inventory.sql](./005_place_inventory.sql) — инвентарь мест вместо зон на карте

Это foundation-миграция для:

- web UI auth и RBAC
- справочника сотрудников и машин
- каталога парковочных мест и линий
- планов этажей (после 005 — статичная подложка, без кликабельных зон)
- постоянных закреплений
- отдач мест, заявок, очереди
- назначений, истории и перемещений
- планов выезда, line occupancy
- contact access logs и audit log
- job runs для ручных/фоновых регламентных запусков

Bootstrap seed:

- [../seeds/001_bootstrap_system_admin.sql](../seeds/001_bootstrap_system_admin.sql)

## Applying

`npm run db:migrate` (см. `packages/db/migrate.js`) применяет файлы этой папки, затем
`../seeds/*.sql`, в лексикографическом порядке и записывает каждый применённый файл в
`schema_migrations`. Команда идемпотентна — повторный запуск не применяет ничего.

## Инвентарь мест (с 005)

Рисование зон по плану этажа удалено. Единица инвентаря — **элемент**: линия на 1–3 места.

- каждый элемент — строка `line_groups`, включая одиночные места (`capacity IN (1, 2, 3)`);
- `line_groups.capacity` — источник истины о размере элемента, `parking_places.place_type`
  выводится из неё, править их по отдельности нельзя;
- `parking_places.line_group_id` — `NOT NULL`, FK переведён на `ON DELETE RESTRICT`:
  место не должно молча потерять свою линию;
- `parking_places.place_role` (`regular` / `rotatable` / `blocked`) заменил
  `parking_place_map_zones.geometry->>'zoneType'`; `rotatable` — это гостевой пул,
  по которому идёт выдача гостям, поэтому 005 переносит роль **до** удаления таблицы зон
  и падает, если количество ролей не сошлось с количеством зон;
- `parking_place_maps` остались — план этажа по-прежнему нужен как статичная подложка;
- `line_groups.display_order` задаёт порядок вывода, `line_groups.archived_at` — архивацию.

Функция `assign_place_lines()` (создаётся в 005) — единственная реализация правила
«у каждого места есть линия»: чинит `capacity` по фактическому числу слотов, заводит
одноместные линии для мест без группы, выводит `place_type` из `capacity` и пересчитывает
`display_order`. Её же вызывает `scripts/import/parking-catalog.js` после импорта.

## Migration Strategy

- каждая следующая миграция получает новый префикс `002_`, `003_` и так далее
- destructive changes не правят `001`, а добавляются новыми миграциями
- бизнес-ограничения сначала фиксируются на уровне БД, потом дублируются в application validation
