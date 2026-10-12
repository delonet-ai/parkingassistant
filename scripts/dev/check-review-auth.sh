#!/usr/bin/env bash
# Is the external reviewer actually able to run?
#
# `codex login status` answers from the file on disk, not from the service: it says
# "Logged in using ChatGPT" while every call returns 401, which is how a 5-hour
# unattended ralphex run reached its review phase and died there. The only honest
# check is a real call, so this makes one.
#
# Run it before launching ralphex. Exit 0 means the review phase will work.

set -uo pipefail

AUTH_FILE="${CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"
PROBE_TIMEOUT="${CODEX_PROBE_TIMEOUT:-120}"

if ! command -v codex >/dev/null 2>&1; then
  echo "codex не установлен — фаза внешнего ревью не запустится" >&2
  exit 2
fi

if [ ! -f "$AUTH_FILE" ]; then
  echo "нет $AUTH_FILE — выполни: codex login --device-auth" >&2
  exit 2
fi

# Age of the last successful refresh. Not a verdict on its own — a token can be
# dead well before this looks old — but it is the one number that says "nobody has
# used this in a while", which is the state that rots quietly.
if command -v jq >/dev/null 2>&1; then
  last_refresh=$(jq -r '.last_refresh // empty' "$AUTH_FILE" 2>/dev/null)
  if [ -n "$last_refresh" ]; then
    now=$(date -u +%s)
    then_ts=$(date -u -d "$last_refresh" +%s 2>/dev/null || echo "$now")
    echo "последнее обновление токена: $last_refresh ($(( (now - then_ts) / 86400 )) дн. назад)"
  fi
fi

echo "проверяю вызовом (до ${PROBE_TIMEOUT}с)..."
probe=$(echo "" | timeout "$PROBE_TIMEOUT" codex exec \
  --sandbox read-only --skip-git-repo-check "Reply with exactly: ok" 2>&1)
status=$?

if [ "$status" -eq 124 ]; then
  echo "codex не ответил за ${PROBE_TIMEOUT}с — сеть или сервис" >&2
  exit 1
fi

if printf '%s' "$probe" | grep -qiE "could not be refreshed|401 Unauthorized|please log out"; then
  echo "codex НЕ авторизован: токен мёртв." >&2
  echo "  починить здесь:  codex login --device-auth" >&2
  echo "  сохранить на хост (нужен root): sudo claude-dev-ctl save-codex-auth $(hostname)" >&2
  exit 1
fi

if [ "$status" -ne 0 ]; then
  echo "codex завершился с кодом $status:" >&2
  printf '%s\n' "$probe" | tail -5 >&2
  exit 1
fi

echo "codex авторизован и отвечает — фаза ревью пройдёт"
