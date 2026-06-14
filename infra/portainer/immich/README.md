# Immich Portainer Stack

This stack is intended for Portainer Git deployment.

## Portainer settings

- Repository URL: `https://github.com/delonet-ai/parkingassistant.git`
- Compose path: `infra/portainer/immich/docker-compose.yml`
- Stack name: `immich`

## Required environment variable

Set this in Portainer before deployment:

```env
DB_PASSWORD=replaceWithLongAlphanumericPassword
```

Immich recommends using only `A-Za-z0-9` for the Postgres password.

## Optional environment variables

```env
IMMICH_VERSION=release
IMMICH_PORT=2283
TZ=Europe/Moscow
UPLOAD_LOCATION=/docker/appdata/immich/library
DB_DATA_LOCATION=/docker/appdata/immich/postgres
DB_USERNAME=postgres
DB_DATABASE_NAME=immich
```

## External libraries

The host photo sources are mounted read-only into `immich-server`.

Add these paths in the Immich admin UI under External Libraries:

```text
/external/Sorted
/external/Files_without_source
/external/Olya_all
```

Host paths:

```text
/srv/Archive/Sorted
/srv/Archive/Файлы без источника
/srv/Archive/Olya_all
```
