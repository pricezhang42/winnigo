#!/bin/sh
# Docker Compose for production or staging (docs/32-deployment.md), from the checkout's root:
#   deploy/compose.sh ps | logs -f web | run --rm release | up -d --build ...
# The checkout's env file picks the stage: .env.production, or .env.staging in the staging
# checkout. Staging gets its own project, image and volumes, and no Caddy of its own.
set -eu
cd "$(dirname "$0")/.."
if [ -f .env.production ] && [ -f .env.staging ]; then
  echo 'Both .env.production and .env.staging exist; keep only the one for this checkout.' >&2
  exit 1
elif [ -f .env.production ]; then
  export WINNIGO_STAGE=production WINNIGO_CADDY_SCALE=1
  project=winnigo
elif [ -f .env.staging ]; then
  export WINNIGO_STAGE=staging WINNIGO_CADDY_SCALE=0
  project=winnigo-staging
else
  echo 'Missing .env.production (copy .env.production.example) or .env.staging.' >&2
  exit 1
fi
docker network inspect winnigo-edge >/dev/null 2>&1 || docker network create winnigo-edge >/dev/null
exec docker compose -p "$project" --env-file ".env.$WINNIGO_STAGE" -f compose.production.yaml "$@"
