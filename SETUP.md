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
- относительные пути `./staging/...`

Отличается только:

- содержимое `staging/env/app.env`
- реальные домены, токены, секреты и порты

## Current Limitation

Сервисы `api`, `admin-web`, `bot-adapter`, `jobs` пока запускаются с placeholder-командами.

Это нормально на текущем этапе: инфраструктурный baseline уже зафиксирован, но реальный runtime будет подключен после выбора package manager/framework и добавления app skeleton.

## Next Recommended Steps

1. Создать `staging/...` локально и на сервере.
2. Подготовить `staging/env/app.env` для обеих сред.
3. Поднять `postgres` и проверить доступность контейнера.
4. Прогнать [packages/db/schema/001_initial_schema.sql](/Users/deliter/Documents/GitClone/parkingassistant/packages/db/schema/001_initial_schema.sql) на живой БД.
5. После этого добавить `seed` базового `system_admin`.

