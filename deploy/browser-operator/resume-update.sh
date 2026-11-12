#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
release_dir="$(cd "$(dirname "$0")" && pwd)"
if [[ ! -f "$release_dir/initial-deploy.exit" && -f "$release_dir/deploy.exit" ]]; then
  cp "$release_dir/deploy.exit" "$release_dir/initial-deploy.exit"
fi
trap 'result=$?; printf "%s\n" "$result" > "$release_dir/resume.exit"; printf "%s\n" "$result" > "$release_dir/deploy.exit"' EXIT
exec 8>/opt/repodesk/.storage.lock
flock -n 8 || { echo 'Deployment storage lock is busy.' >&2; exit 1; }
python3 "$release_dir/resume-update.py" "$release_dir" --resume > "$release_dir/resume-driver.log" 2>&1
