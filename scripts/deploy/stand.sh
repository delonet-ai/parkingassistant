#!/bin/sh

# Deploy the test stand from the host checkout. Run it ON the OMV server, not from the dev
# container — the build context has to be readable by the docker client, which is why the stand
# deploys from a checkout at all (see docs/adr/005-stand-deploy-via-host-checkout.md).
#
#   ssh omv /opt/git/parkingassistant/scripts/deploy/stand.sh
#
# Idempotent: pulls main, rebuilds what changed, recreates only the services whose image or
# config moved. staging/ is never touched — the database, maps and imports live there.
#
#   SKIP_PULL=1   deploy the checkout as it stands (useful when testing an unpushed branch)
#   NO_BUILD=1    restart from the images already built

set -eu

ROOT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/staging/env/app.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.yml}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-180}"

log() {
  echo "==> $*"
}

if [ ! -f "$ENV_FILE" ]; then
  echo "Env file not found: $ENV_FILE" >&2
  echo "Copy .env.example there and set the stand's values." >&2
  exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Compose file not found: $COMPOSE_FILE" >&2
  exit 1
fi

cd "$ROOT_DIR"

# A dirty checkout means the stand would run something that is not in git, and nobody could tell
# from `git log` what is deployed. Refuse rather than build it. staging/ is gitignored, so the
# stand's own data never makes the tree dirty.
if [ "${SKIP_PULL:-0}" != "1" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "Checkout is dirty — commit, stash or revert before deploying:" >&2
    git status --short >&2
    exit 1
  fi

  log "Pulling $(git rev-parse --abbrev-ref HEAD)"
  git pull --ff-only
fi

log "Deploying $(git rev-parse --short HEAD) ($(git log -1 --format=%s))"

# --remove-orphans: a service deleted from the compose file keeps running otherwise, and it
# keeps its published port with it — which is how the old admin container went on answering
# on 3340 while its replacement came up with no ports at all.
if [ "${NO_BUILD:-0}" = "1" ]; then
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --remove-orphans
else
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build --remove-orphans
fi

# `up -d` returns as soon as the containers are created; the one-shot migrate container and the
# health checks are what actually say the stand is up.
log "Waiting for api and admin-ui to report healthy (max ${HEALTH_TIMEOUT_SECONDS}s)"

waited=0
while [ "$waited" -lt "$HEALTH_TIMEOUT_SECONDS" ]; do
  api_state="$(docker inspect --format '{{.State.Health.Status}}' parkingassistant-api 2>/dev/null || echo missing)"
  admin_state="$(docker inspect --format '{{.State.Health.Status}}' parkingassistant-admin-ui 2>/dev/null || echo missing)"

  if [ "$api_state" = "healthy" ] && [ "$admin_state" = "healthy" ]; then
    log "api and admin-ui are healthy"
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
    log "Now verify from the dev container: npm run smoke:stand"
    exit 0
  fi

  if [ "$api_state" = "unhealthy" ] || [ "$admin_state" = "unhealthy" ]; then
    echo "Service reported unhealthy (api=$api_state admin-ui=$admin_state)" >&2
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs --tail 50 api admin-ui >&2
    exit 1
  fi

  sleep 5
  waited=$((waited + 5))
done

echo "Timed out after ${HEALTH_TIMEOUT_SECONDS}s (api=$api_state admin-ui=$admin_state)" >&2
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps >&2
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs --tail 50 migrate api admin-ui >&2
exit 1
