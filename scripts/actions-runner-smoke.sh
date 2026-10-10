#!/usr/bin/env bash
# Verify resource-limited Docker-in-Docker without registering a GitHub runner.
set -euo pipefail

runner_image="${1:-repodesk-actions-runner:test}"
smoke_root=$(mktemp -d)
smoke_name="repodesk-actions-smoke-${smoke_root##*/}"
cleanup() {
  docker rm --force "$smoke_name" >/dev/null 2>&1 || true
  docker volume rm "$smoke_name-runner" "$smoke_name-docker" >/dev/null 2>&1 || true
  rmdir "$smoke_root"
}
trap cleanup EXIT

docker run --detach --pull=never --name "$smoke_name" \
  --privileged --init --cpus=2 --memory=4g --memory-swap=4g \
  --volume "$smoke_name-runner:/opt/actions-runner" \
  --volume "$smoke_name-docker:/var/lib/docker" \
  "$runner_image" >/dev/null
for ((attempt = 0; attempt < 60; attempt++)); do
  if docker exec "$smoke_name" docker info >/dev/null 2>&1; then
    break
  fi
  if [[ $(docker inspect --format '{{.State.Running}}' "$smoke_name") != true ]] || ((attempt == 59)); then
    docker logs "$smoke_name" >&2
    echo 'The smoke Docker daemon did not become ready.' >&2
    exit 1
  fi
  sleep 1
done

# Load a local image into the isolated daemon; no registry or provider is needed.
docker image save "$runner_image" | docker exec --interactive "$smoke_name" docker image load >/dev/null
docker exec "$smoke_name" docker run --rm --pull=never \
  --cpus=0.5 --memory=128m --memory-swap=128m --pids-limit=64 \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --network=none --user=1001:1001 --entrypoint=node "$runner_image" \
  -e '
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    if (fs.existsSync("/sys/fs/cgroup/cgroup.controllers")) {
      const value = (name) => fs.readFileSync("/sys/fs/cgroup/" + name, "utf8").trim();
      assert.equal(value("memory.max"), String(128 * 1024 * 1024));
      assert.equal(value("pids.max"), "64");
      const [quota, period] = value("cpu.max").split(" ").map(Number);
      assert.equal(quota / period, 0.5);
    }
    console.log("Nested Docker resource-limit smoke passed.");
  '

# Run the actual post-job hook as the listener user. It must remove an unused
# disposable volume while retaining a stopped container's volume and image.
docker exec "$smoke_name" docker volume create cleanup-unused >/dev/null
docker exec "$smoke_name" docker create --name cleanup-retained --pull=never \
  --network=none --volume cleanup-retained:/evidence "$runner_image" >/dev/null
docker exec "$smoke_name" runuser -u runner -- /usr/local/bin/actions-runner-cleanup.sh
if docker exec "$smoke_name" docker volume inspect cleanup-unused >/dev/null 2>&1; then
  echo 'CI cleanup left an unreferenced disposable volume.' >&2
  exit 1
fi
docker exec "$smoke_name" docker volume inspect cleanup-retained >/dev/null
docker exec "$smoke_name" docker image inspect "$runner_image" >/dev/null
echo 'CI post-job cleanup smoke passed; referenced storage was retained.'
