#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
./preflight.sh
mkdir -p volumes/postgres volumes/redis volumes/rabbitmq volumes/garage/meta volumes/garage/data
chmod 700 volumes volumes/postgres volumes/redis volumes/rabbitmq volumes/garage volumes/garage/meta volumes/garage/data
docker_config=""
if [ -n "${GHCR_TOKEN:-}" ]; then
  [ -n "${GHCR_USERNAME:-}" ] || { echo "Set GHCR_USERNAME with GHCR_TOKEN." >&2; exit 1; }
  docker_config="$(mktemp -d)"
  chmod 700 "$docker_config"
  export DOCKER_CONFIG="$docker_config"
  trap 'rm -rf "$docker_config"' EXIT
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username "$GHCR_USERNAME" --password-stdin
fi
docker compose --env-file .env -f compose.yaml pull
docker compose --env-file .env -f compose.yaml up -d --remove-orphans
docker compose --env-file .env -f compose.yaml ps
