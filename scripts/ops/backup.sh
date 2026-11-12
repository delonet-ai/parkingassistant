#!/bin/sh

# Back up the stand: the PostgreSQL database plus the mounted storage it points at (floor
# plans and imported catalogs). Run it ON the OMV host, next to the running stack:
#
#   /opt/git/parkingassistant/scripts/ops/backup.sh
#
# Nightly from the host's crontab (03:30, after the day's jobs and before 07:00):
#
#   30 3 * * * /opt/git/parkingassistant/scripts/ops/backup.sh >> /opt/git/parkingassistant/staging/logs/backup.log 2>&1
#
# Writes one directory per run under staging/backups/<timestamp>/:
#   db.dump        pg_dump custom format (restore with scripts/ops/restore.sh)
#   storage.tar.gz staging/maps and staging/imports
#   SHA256SUMS     checksums of both, so a copy can be verified before it is trusted
#
# The dump is taken with `docker exec` inside the postgres container, so the host needs no
# Postgres client and the database port never has to be published.
#
#   KEEP_DAYS=14     how many days of backups to keep (older run directories are deleted)
#   BACKUP_DIR=...   where to write (default: staging/backups in the checkout)

set -eu

ROOT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/staging/env/app.env}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/staging/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
PG_CONTAINER="${PG_CONTAINER:-parkingassistant-postgres}"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') backup: $*"
}

# Only the two names the dump needs, read without sourcing the file: app.env holds secrets
# and nothing else from it belongs in this shell.
env_value() {
  sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -n 1
}

POSTGRES_DB="$(env_value POSTGRES_DB)"
POSTGRES_USER="$(env_value POSTGRES_USER)"
POSTGRES_DB="${POSTGRES_DB:-parkingassistant}"
POSTGRES_USER="${POSTGRES_USER:-parkingassistant}"

if ! docker inspect --format '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null | grep -q true; then
  log "container $PG_CONTAINER is not running — nothing backed up" >&2
  exit 1
fi

STAMP="$(date '+%Y%m%d-%H%M%S')"
TARGET="$BACKUP_DIR/$STAMP"
PARTIAL="$TARGET.partial"

mkdir -p "$PARTIAL"
# A failed run must not leave a directory that looks like a good backup.
trap 'rm -rf "$PARTIAL"' EXIT

log "dumping $POSTGRES_DB from $PG_CONTAINER"
docker exec "$PG_CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$PARTIAL/db.dump"

# A custom-format dump with no table of contents is a broken dump; pg_restore --list is the
# cheapest proof that the file can be read back.
docker exec -i "$PG_CONTAINER" pg_restore --list < "$PARTIAL/db.dump" > /dev/null

log "archiving maps and imports"
tar -czf "$PARTIAL/storage.tar.gz" -C "$ROOT_DIR/staging" maps imports

(cd "$PARTIAL" && sha256sum db.dump storage.tar.gz > SHA256SUMS)

mv "$PARTIAL" "$TARGET"
trap - EXIT

log "written $TARGET ($(du -sh "$TARGET" | cut -f1))"

# Rotation: run directories only, matched by name, so nothing else in the folder is touched.
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*-[0-9]*' -mtime +"$KEEP_DAYS" \
  -exec rm -rf {} + -exec echo "$(date '+%Y-%m-%d %H:%M:%S') backup: removed old {}" \;

log "done"
