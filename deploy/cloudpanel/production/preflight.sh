#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "Run ./prepare-env.py and review .env first." >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker Engine is not installed." >&2; exit 1; }
docker compose version >/dev/null
docker info >/dev/null
docker compose --env-file .env -f compose.yaml config --quiet
grep -Fq '127.0.0.1:' compose.yaml || { echo "Manager gateway must bind to loopback." >&2; exit 1; }
grep -Fq './volumes/postgres:/var/lib/postgresql/data' compose.yaml || { echo "Relative Postgres bind mount is missing." >&2; exit 1; }
grep -Fq './volumes/redis:/data' compose.yaml || { echo "Relative Redis bind mount is missing." >&2; exit 1; }
grep -Fq './volumes/rabbitmq:/var/lib/rabbitmq' compose.yaml || { echo "Relative RabbitMQ bind mount is missing." >&2; exit 1; }
grep -Fq './volumes/garage/meta:/var/lib/garage/meta' compose.yaml || { echo "Relative Garage metadata bind mount is missing." >&2; exit 1; }
grep -Fq './volumes/garage/data:/var/lib/garage/data' compose.yaml || { echo "Relative Garage data bind mount is missing." >&2; exit 1; }
for key in POSTGRES_PASSWORD REDIS_PASSWORD RABBITMQ_PASSWORD S3_SECRET_ACCESS_KEY GARAGE_RPC_SECRET GARAGE_ADMIN_TOKEN SCOUT_JWT_SECRET SCOUT_ENCRYPTION_KEY_BASE64 SCOUT_BOOTSTRAP_ADMIN_PASSWORD; do
  value="$(sed -n "s/^$key=//p" .env | head -1)"
  [ -n "$value" ] && [ "$value" != replace-me ] || { echo "Missing or placeholder secret: $key" >&2; exit 1; }
done
echo "Preflight OK: Compose syntax, secrets, relative binds and gateway loopback."
