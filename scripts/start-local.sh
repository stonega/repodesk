#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ ! -f .env ]]; then
  echo "Missing .env. Follow docs/implementation/setup.md first." >&2
  exit 1
fi

if ! command -v podman >/dev/null 2>&1; then
  echo "Podman is required to start the local stack." >&2
  exit 1
fi

if [[ $# -gt 1 || ( $# -eq 1 && $1 != --build ) ]]; then
  echo "Usage: scripts/start-local.sh [--build]" >&2
  exit 2
fi

if podman compose config --services | grep -qx codex-runner; then
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "The Codex overlay requires a running rootless Podman socket." >&2
    exit 1
  fi
  systemctl --user start podman.socket
fi

if [[ ${1:-} == --build ]]; then
  podman compose up -d --build
else
  podman compose up -d --no-build
fi

echo "Local stack: http://localhost:3000"
echo "Check readiness: curl http://localhost:3000/readyz"
