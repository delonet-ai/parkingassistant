#!/bin/sh

set -eu

ROOT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/staging/env/app.env}"
SCHEMA_FILE="${SCHEMA_FILE:-$ROOT_DIR/packages/db/schema/001_initial_schema.sql}"
POSTGRES_CONTAINER_NAME="${POSTGRES_CONTAINER_NAME:-parkingassistant-postgres}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Env file not found: $ENV_FILE" >&2
  exit 1
fi

if [ ! -f "$SCHEMA_FILE" ]; then
  echo "Schema file not found: $SCHEMA_FILE" >&2
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

: "${POSTGRES_DB:?POSTGRES_DB is required in $ENV_FILE}"
: "${POSTGRES_USER:?POSTGRES_USER is required in $ENV_FILE}"

docker exec -i "$POSTGRES_CONTAINER_NAME" \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  < "$SCHEMA_FILE"

echo "Migration applied from $SCHEMA_FILE"
