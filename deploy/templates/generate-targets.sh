#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
for target in docker dockge cloudpanel portainer; do
  for channel in develop production; do
    destination="$root/deploy/$target/$channel"
    mkdir -p "$destination"
    for file in compose.yaml env.example garage.toml prepare-env.py deploy.sh preflight.sh bootstrap.sh status.sh backup.sh restore.sh; do
      if [ "$file" = env.example ]; then
        cp "$root/deploy/templates/$file" "$destination/.env.example"
      else
        cp "$root/deploy/templates/$file" "$destination/$file"
      fi
    done
    if [ "$channel" = production ]; then
      sed -i 's/^SCOUT_ENV=develop$/SCOUT_ENV=production/;s/^SCOUT_VERSION=0.2.0-alpha.2$/SCOUT_VERSION=0.2.0/;s/^SCOUT_TAG=develop$/SCOUT_TAG=stable/;s/:develop$/:stable/;s|^SCOUT_PUBLIC_URL=.*$|SCOUT_PUBLIC_URL=https://scout.example.com|;s/^SCOUT_COOKIE_SECURE=false$/SCOUT_COOKIE_SECURE=true/;s/^SCOUT_ALLOW_HTTP=true$/SCOUT_ALLOW_HTTP=false/' "$destination/.env.example"
    fi
    chmod 750 "$destination"/*.sh "$destination/prepare-env.py"
  done
done
printf 'Rendered 8 deployment bundles. Review target READMEs and channel environment values.\n'
