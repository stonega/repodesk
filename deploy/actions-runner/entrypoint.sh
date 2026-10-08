#!/usr/bin/env bash
set -euo pipefail

docker_pid=
runner_pid=
cleanup() {
  trap - EXIT TERM INT
  if [[ -n "$runner_pid" ]]; then
    kill -TERM "$runner_pid" 2>/dev/null || true
    wait "$runner_pid" 2>/dev/null || true
  fi
  if [[ -n "$docker_pid" ]]; then
    kill -TERM "$docker_pid" 2>/dev/null || true
    wait "$docker_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

dockerd --host=unix:///var/run/docker.sock > /tmp/actions-docker.log 2>&1 &
docker_pid=$!
for ((attempt = 0; attempt < 60; attempt++)); do
  if docker info > /dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$docker_pid" 2>/dev/null; then
    echo 'The CI Docker daemon failed to start.' >&2
    exit 1
  fi
  sleep 1
done
docker info > /dev/null

cd /opt/actions-runner
echo 'CI Docker is ready; waiting for GitHub runner registration.'
until [[ -f .runner ]]; do
  kill -0 "$docker_pid"
  sleep 2
done

runuser -u runner -- ./run.sh &
runner_pid=$!
while kill -0 "$runner_pid" 2>/dev/null; do
  if ! kill -0 "$docker_pid" 2>/dev/null; then
    echo 'The CI Docker daemon stopped.' >&2
    exit 1
  fi
  sleep 2
done
wait "$runner_pid"
