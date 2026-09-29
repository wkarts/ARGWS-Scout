#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
docker compose --env-file .env -f compose.yaml exec -T api pnpm db:seed
echo "OWNER created; MFA enrollment is required at first login."

