#!/usr/bin/env bash
# Run on the provisioned VPS; configuration and secrets stay on that host.
set -Eeuo pipefail
umask 077

fail() {
  printf 'Deployment preflight failed: %s\n' "$1" >&2
  exit 1
}

deploy_root="${1:?Usage: deploy-vps.sh DEPLOY_ROOT RELEASE_ID COMPOSE_PROJECT}"
release_id="${2:?Missing release ID}"
project="${3:?Missing Compose project}"
[[ "$deploy_root" = /* && "$deploy_root" != / ]]
[[ "$release_id" =~ ^[0-9]+-[0-9]+$ ]]
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]]
cd "$deploy_root"
deploy_root="$PWD"
release_dir="$deploy_root/releases/$release_id"
[[ -f "$deploy_root/.env" ]] || fail "Missing runtime configuration: $deploy_root/.env"
for file in compose.yaml image-tag image-sha256 image.tar.gz; do
  [[ -f "$release_dir/$file" ]] || fail "Missing release artifact: $file"
done
for executable in docker flock sha256sum; do
  command -v "$executable" > /dev/null || fail "Required command is not installed: $executable"
done
backup_path="$deploy_root/backups/pre-release-$release_id.dump"
# Refuse a repeated bundle before stopping services or overwriting its backup.
[[ ! -e "$backup_path" ]] || fail "This bundle already has a backup; use a new run attempt."

# Also fence deployments started directly by an operator.
exec 9> "$deploy_root/.deploy.lock"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }

image_tag="$(cat "$release_dir/image-tag")"
[[ "$image_tag" =~ ^repodesk:release-[a-f0-9]{40}$ ]] || fail 'Invalid release image tag.'
expected_hash="$(cat "$release_dir/image-sha256")"
[[ "$expected_hash" =~ ^[a-f0-9]{64}$ ]] || fail 'Invalid image archive checksum.'
actual_hash="$(sha256sum "$release_dir/image.tar.gz")"
[[ "${actual_hash%% *}" = "$expected_hash" ]] || fail 'Image archive checksum mismatch.'
[[ "$(docker info --format '{{.Architecture}}')" =~ ^(x86_64|amd64)$ ]] || {
  echo 'Release images require an x86_64 VPS.' >&2
  exit 1
}
docker image load --input "$release_dir/image.tar.gz"
# Classic and containerd stores can report different IDs for the same archive.
# Resolve the verified archive's tag on this daemon, then pin its immutable ID.
image_id="$(docker image inspect --format '{{.Id}}' "$image_tag")"
[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'Docker returned an invalid imported image ID.'
printf 'APP_IMAGE=%s\n' "$image_id" > "$release_dir/release.env"
export APP_IMAGE="$image_id"
compose=(docker compose --project-directory "$deploy_root" -p "$project"
  --env-file "$deploy_root/.env" --env-file "$release_dir/release.env"
  -f "$release_dir/compose.yaml")
codex=false
if [[ -f "$release_dir/codex-compose.yaml" ]]; then
  codex=true
  for artifact in codex-supervisor-tag codex-job-tag codex-release-config.mjs codex-wait-checkpoint.mjs; do
    [[ -f "$release_dir/$artifact" ]] || fail "Missing Codex release artifact: $artifact"
  done
  supervisor_tag="$(cat "$release_dir/codex-supervisor-tag")"
  job_tag="$(cat "$release_dir/codex-job-tag")"
  [[ "$supervisor_tag" =~ ^repodesk-codex-supervisor:release-[a-f0-9]{40}$ ]] || fail 'Invalid Codex supervisor image tag.'
  [[ "$job_tag" =~ ^repodesk-codex-job:release-[a-f0-9]{40}$ ]] || fail 'Invalid Codex job image tag.'
  supervisor_id="$(docker image inspect --format '{{.Id}}' "$supervisor_tag")"
  job_id="$(docker image inspect --format '{{.Id}}' "$job_tag")"
  [[ "$supervisor_id" =~ ^sha256:[a-f0-9]{64}$ && "$job_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'Invalid imported Codex image ID.'
  # Generate once, never print tokens, and preserve credentials across releases.
  docker run --rm --network none --user "$(id -u):$(id -g)" --security-opt label=disable --entrypoint node \
    --volume "$deploy_root:/deployment" --volume "$release_dir:/release" \
    --env "CODEX_SUPERVISOR_IMAGE=$supervisor_id" --env "CODEX_RUNNER_IMAGE=$job_id" \
    "$image_id" /release/codex-release-config.mjs /deployment /release "$project"
  compose=(docker compose --project-directory "$deploy_root" -p "$project"
    --env-file "$deploy_root/.env" --env-file "$release_dir/release.env"
    --env-file "$release_dir/codex.env" -f "$release_dir/compose.yaml"
    -f "$release_dir/codex-compose.yaml")
fi
"${compose[@]}" config --quiet
# Check the actual runtime user's secret access, including host SELinux labels.
"${compose[@]}" run --rm --no-deps --pull never -T --entrypoint node migrate -e \
  "require('fs').accessSync(process.env.ENCRYPTION_KEY_FILE,require('fs').constants.R_OK)"
# Pull only the pinned database image, before stopping any writers.
"${compose[@]}" pull postgres

cutover_started=false
writers_stopped=false
running_writers=()
on_error() {
  status=$?
  trap - ERR
  if [[ "$cutover_started" = true ]]; then
    "${compose[@]}" stop app worker || true
    echo 'Deployment failed; app/worker stopped. Inspect migrations and the backup before recovery.' >&2
  elif [[ "$writers_stopped" = true && "${#running_writers[@]}" -gt 0 ]]; then
    # No images or schema have changed. Restart only services that were running.
    "${compose[@]}" start "${running_writers[@]}" || true
    echo 'Deployment deferred before cutover; existing writers restarted and the runner was preserved.' >&2
  fi
  exit "$status"
}
trap on_error ERR

checkpoint_timeout="${CODEX_DEPLOY_CHECKPOINT_TIMEOUT_SECONDS:-1800}"
[[ "$checkpoint_timeout" =~ ^[1-9][0-9]{0,3}$ ]] && (( checkpoint_timeout <= 1800 )) || fail 'Checkpoint wait must be 1–1800 seconds.'
checkpoint_deadline=$((SECONDS + checkpoint_timeout))
wait_for_coding_checkpoint() {
  [[ "$codex" = true ]] || return 0
  local runner_id remaining
  runner_id="$("${compose[@]}" ps --status running --quiet codex-runner)"
  [[ -n "$runner_id" ]] || return 0
  remaining=$((checkpoint_deadline - SECONDS))
  (( remaining > 0 )) || remaining=1
  "${compose[@]}" exec -T codex-runner node --input-type=module - "$remaining" \
    < "$release_dir/codex-wait-checkpoint.mjs"
}
# Keep the current bot and provider proxy available while existing turns finish.
wait_for_coding_checkpoint
active_writers="$("${compose[@]}" ps --status running --services app worker)"
while IFS= read -r service; do
  case "$service" in
    app|worker) running_writers+=("$service") ;;
    '') ;;
    *) fail 'Unexpected running service.' ;;
  esac
done <<< "$active_writers"
writers_stopped=true
"${compose[@]}" stop app worker
# Close the race with an attempt started just before the writers stopped.
# Task containers keep running under the old supervisor until a saved checkpoint.
wait_for_coding_checkpoint
cutover_started=true
if [[ "$codex" = true ]]; then
  "${compose[@]}" up -d --no-deps --no-build --pull never --wait --wait-timeout 180 codex-runner
fi
"${compose[@]}" up -d --no-deps --wait --wait-timeout 120 postgres
mkdir -p "$deploy_root/backups"
# A rerun has a new release ID, so an earlier backup is never overwritten.
[[ ! -e "$backup_path" ]]
"${compose[@]}" exec -T postgres pg_dump -U deepx -d deepx --format=custom > "$backup_path"
[[ -s "$backup_path" ]]
"${compose[@]}" exec -T postgres pg_restore --list < "$backup_path" > /dev/null

# Old writers are stopped, and migrations must succeed before either new writer starts.
"${compose[@]}" run --rm --no-deps --pull never -T migrate
"${compose[@]}" up -d --no-deps --no-build --pull never --wait --wait-timeout 180 app worker
# Container health can precede the first Telegram long poll. Allow startup to finish.
readiness_deadline=$((SECONDS + 120))
readiness_status=1
ready=false
for attempt in {1..24}; do
  remaining=$((readiness_deadline - SECONDS))
  (( remaining > 0 )) || break
  if "${compose[@]}" exec -T app node -e \
    "fetch('http://127.0.0.1:'+process.env.PORT+'/readyz',{signal:AbortSignal.timeout(Math.min(10000,Number(process.argv[1])*1000))}).then(r=>{if(!r.ok){console.error('Readiness HTTP '+r.status);process.exit(1)}}).catch(()=>{console.error('Readiness request failed or timed out');process.exit(1)})" "$remaining"; then
    ready=true
    break
  else
    readiness_status=$?
  fi
  printf 'Waiting for application readiness (%s/24).\n' "$attempt" >&2
  remaining=$((readiness_deadline - SECONDS))
  if (( attempt < 24 && remaining > 0 )); then
    sleep "$((remaining < 5 ? remaining : 5))"
  fi
done
if [[ "$ready" != true ]]; then
  echo 'Application readiness did not succeed within the startup window.' >&2
  # Preserve the normal cutover error handler and prior release marker.
  (exit "$readiness_status")
fi

printf '%s\n' "$release_id" > "$deploy_root/.current-release.tmp"
mv "$deploy_root/.current-release.tmp" "$deploy_root/.current-release"
rm "$release_dir/image.tar.gz"
printf 'Deployed release %s (%s). Backup: %s\n' "$release_id" "$image_id" "$backup_path"
