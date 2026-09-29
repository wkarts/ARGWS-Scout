#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
version="$(tr -d '\r\n' < "$root/VERSION")"
if [[ "$version" =~ -alpha\.[0-9]+$ ]]; then
  release_tag="$version"
else
  release_tag="stable"
fi
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
      sed -i \
        -e 's/^SCOUT_ENV=develop$/SCOUT_ENV=production/' \
        -e "s/^SCOUT_VERSION=.*/SCOUT_VERSION=$version/" \
        -e "s/^SCOUT_TAG=.*/SCOUT_TAG=$release_tag/" \
        -e "s/:develop$/:$release_tag/" \
        -e 's|^SCOUT_PUBLIC_URL=.*$|SCOUT_PUBLIC_URL=https://scout.example.com|' \
        -e 's/^SCOUT_COOKIE_SECURE=false$/SCOUT_COOKIE_SECURE=true/' \
        -e 's/^SCOUT_ALLOW_HTTP=true$/SCOUT_ALLOW_HTTP=false/' \
        "$destination/.env.example"
    fi
    chmod 750 "$destination"/*.sh "$destination/prepare-env.py"
  done
done
printf 'Rendered 8 deployment bundles. Review target READMEs and channel environment values.\n'
