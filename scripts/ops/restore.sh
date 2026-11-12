#!/bin/sh

# Restore the stand from a directory written by scripts/ops/backup.sh. Run it ON the OMV host:
#
#   /opt/git/parkingassistant/scripts/ops/restore.sh staging/backups/20261112-033000
#
# What it does, in order:
#   1. verifies SHA256SUMS of the backup;
#   2. takes a safety backup of the CURRENT state first (scripts/ops/backup.sh), so a restore
#      onto the wrong backup can itself be undone;
#   3. stops api, admin-ui and jobs, so nothing writes while the database is replaced;
#   4. drops and recreates the database, restores db.dump into it;
#   5. unpacks maps and imports over staging/ (with --storage, see below);
#   6. starts the stack again through the normal deploy path, which re-runs migrations.
#
# It refuses to run without typing the database name, because step 4 deletes live data.
#
#   --storage      also restore staging/maps and staging/imports (default: database only)
#   --yes          skip the confirmation prompt (for scripted drills on a scratch host only)

set -eu

ROOT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/staging/env/app.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.yml}"
PG_CONTAINER="${PG_CONTAINER:-parkingassistant-postgres}"

SOURCE=""
WITH_STORAGE=0
ASSUME_YES=0

for arg in "$@"; do
  case "$arg" in
    --storage) WITH_STORAGE=1 ;;
    --yes) ASSUME_YES=1 ;;
    -*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) SOURCE="$arg" ;;
  esac
done

if [ -z "$SOURCE" ] || [ ! -f "$SOURCE/db.dump" ]; then
  echo "Usage: $0 <backup-dir> [--storage] [--yes]" >&2
  echo "The directory must contain db.dump (written by scripts/ops/backup.sh)." >&2
  exit 2
fi

SOURCE="$(CDPATH='' cd -- "$SOURCE" && pwd)"

log() {
  echo "==> $*"
}

env_value() {
  sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -n 1
}

POSTGRES_DB="$(env_value POSTGRES_DB)"
POSTGRES_USER="$(env_value POSTGRES_USER)"
POSTGRES_DB="${POSTGRES_DB:-parkingassistant}"
POSTGRES_USER="${POSTGRES_USER:-parkingassistant}"

if [ -f "$SOURCE/SHA256SUMS" ]; then
  log "Verifying checksums"
  (cd "$SOURCE" && sha256sum -c SHA256SUMS)
else
  echo "No SHA256SUMS in $SOURCE — cannot verify the backup, refusing." >&2
  exit 1
fi

if [ "$ASSUME_YES" != "1" ]; then
  echo "This REPLACES database '$POSTGRES_DB' with $SOURCE/db.dump."
  [ "$WITH_STORAGE" = "1" ] && echo "It also overwrites staging/maps and staging/imports."
  printf "Type the database name to continue: "
  read -r answer
  if [ "$answer" != "$POSTGRES_DB" ]; then
    echo "Aborted." >&2
    exit 1
  fi
fi

log "Safety backup of the current state"
"$ROOT_DIR/scripts/ops/backup.sh"

log "Stopping api, admin-ui and jobs"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" stop jobs admin-ui api

log "Recreating database $POSTGRES_DB"
docker exec "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "drop database if exists \"$POSTGRES_DB\" with (force)" \
  -c "create database \"$POSTGRES_DB\" owner \"$POSTGRES_USER\""

log "Restoring $SOURCE/db.dump"
docker exec -i "$PG_CONTAINER" pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --no-owner --exit-on-error < "$SOURCE/db.dump"

if [ "$WITH_STORAGE" = "1" ]; then
  log "Restoring maps and imports"
  tar -xzf "$SOURCE/storage.tar.gz" -C "$ROOT_DIR/staging"
fi

log "Starting the stack"
SKIP_PULL=1 NO_BUILD=1 "$ROOT_DIR/scripts/deploy/stand.sh"

log "Restore finished from $SOURCE"
