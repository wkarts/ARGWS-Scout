#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
destination="$(pwd)/backups/$stamp"
mkdir -p "$destination"
chmod 700 backups "$destination"
docker compose --env-file .env -f compose.yaml stop api dispatcher worker browser-worker scheduler webhook-worker
trap 'docker compose --env-file .env -f compose.yaml start api dispatcher worker browser-worker scheduler webhook-worker garage' EXIT
docker compose --env-file .env -f compose.yaml exec -T postgres sh -ec 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$destination/postgres.dump"
docker compose --env-file .env -f compose.yaml stop garage
tar -C volumes/garage -czf "$destination/garage.tar.gz" .
docker compose --env-file .env -f compose.yaml start garage api dispatcher worker browser-worker scheduler webhook-worker
trap - EXIT
echo "Backup created: $destination"
