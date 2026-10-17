#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ ! -f .env ]]; then
  echo "Missing .env. Follow docs/implementation/setup.md first." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to start the local stack." >&2
  exit 1
fi

if [[ $# -gt 1 || ( $# -eq 1 && $1 != --build ) ]]; then
  echo "Usage: scripts/start-local.sh [--build]" >&2
  exit 2
fi

docker compose config --quiet

if [[ ${1:-} == --build ]]; then
  docker compose up -d --build
else
  docker compose up -d --no-build
fi

echo "Local stack: http://localhost:3000"
echo "Check readiness: curl http://localhost:3000/readyz"
