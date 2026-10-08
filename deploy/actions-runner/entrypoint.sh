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

# Prepare the private cgroup v2 namespace before Docker creates child cgroups.
# Domain controllers such as memory cannot be delegated while the parent has
# processes. This follows Moby's hack/dind initialization, with bounded retries.
if [[ -f /sys/fs/cgroup/cgroup.controllers ]]; then
  mkdir -p /sys/fs/cgroup/init
  cgroup_controllers=$(sed -e 's/ / +/g' -e 's/^/+/' /sys/fs/cgroup/cgroup.controllers)
  for ((attempt = 0; attempt < 30; attempt++)); do
    # Ignore processes which exited between reading the list and moving them.
    xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true
    if printf '%s\n' "$cgroup_controllers" > /sys/fs/cgroup/cgroup.subtree_control; then
      break
    fi
    if ((attempt == 29)); then
      echo 'The CI Docker cgroup v2 controllers could not be enabled.' >&2
      exit 1
    fi
    sleep 0.1
  done
fi

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
