#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ "${1:-}" != --confirm-replace-current-data ] || [ -z "${2:-}" ]; then
  echo "Usage: ./restore.sh --confirm-replace-current-data ./backups/TIMESTAMP" >&2
  exit 2
fi
backup="$(realpath "$2")"
[ -s "$backup/postgres.dump" ] && [ -f "$backup/garage.tar.gz" ] || { echo "Incomplete backup." >&2; exit 1; }
docker compose --env-file .env -f compose.yaml stop api dispatcher worker browser-worker scheduler webhook-worker garage
docker compose --env-file .env -f compose.yaml exec -T postgres sh -ec 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < "$backup/postgres.dump"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mv volumes/garage "volumes/garage.pre-restore-$stamp"
mkdir -p volumes/garage
tar -C volumes/garage -xzf "$backup/garage.tar.gz"
chmod 700 volumes/garage
docker compose --env-file .env -f compose.yaml up -d --remove-orphans
docker compose --env-file .env -f compose.yaml ps
echo "Previous Garage data remains under volumes/garage.pre-restore-$stamp."
