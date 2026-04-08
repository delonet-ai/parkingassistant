# DB Scripts

## Files

- [migrate.sh](/Users/deliter/Documents/GitClone/parkingassistant/scripts/db/migrate.sh)
- [seed.sh](/Users/deliter/Documents/GitClone/parkingassistant/scripts/db/seed.sh)

## Usage

Оба скрипта рассчитаны на уже поднятый контейнер `postgres` из нашего stack.

### Apply schema

```bash
sh scripts/db/migrate.sh
```

### Apply bootstrap seed

```bash
sh scripts/db/seed.sh
```

## Notes

- скрипты читают env из `staging/env/app.env`
- `psql` запускается внутри контейнера `parkingassistant-postgres` через `docker exec`
- это удобно и для OMV, и для Portainer-managed deployment, потому что не требует `psql` на хосте и не зависит от compose CLI проекта
- bootstrap seed создает `sysadmin` в статусе `invited` с placeholder password hash, потому что финальная auth-стратегия приложения еще не зафиксирована в runtime-коде
