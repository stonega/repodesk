#!/usr/bin/env bash
# The runner executes this synchronously after every job, before accepting another.
set -euo pipefail
ci_docker=(docker --host unix:///var/run/docker.sock)
# Never allow this disposable-volume policy to target the production daemon.
labels=$(timeout 15 "${ci_docker[@]}" info --format '{{json .Labels}}')
if [[ "$labels" != *'"repodesk.ci=true"'* ]]; then
  echo 'CI cleanup refused: Docker daemon is not labeled repodesk.ci=true.' >&2
  exit 1
fi
prune() {
  if ! timeout 120 "${ci_docker[@]}" "$@"; then
    echo "CI Docker cleanup failed or timed out: $1 $2. Retry after the next job." >&2
  fi
}
prune image prune --all --force --filter until=24h
prune builder prune --all --force --keep-storage 2GB
# Only the isolated CI daemon: unreferenced test volumes are disposable. Outer
# runner credentials, production PostgreSQL and Codex task volumes are untouched.
prune volume prune --all --force
