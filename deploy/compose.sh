#!/bin/sh
# Docker Compose for production (docs/32-deployment.md), from the repository root:
#   deploy/compose.sh ps | logs -f web | run --rm release | up -d --build ...
set -eu
cd "$(dirname "$0")/.."
[ -f .env.production ] || { echo 'Missing .env.production (copy .env.production.example).' >&2; exit 1; }
exec docker compose --env-file .env.production -f compose.production.yaml "$@"
