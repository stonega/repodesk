#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
release_dir="$(cd "$(dirname "$0")" && pwd)"
trap 'result=$?; printf "%s\n" "$result" > "$release_dir/deploy.exit"' EXIT
exec 8> /opt/repodesk/.storage.lock
flock -n 8 || { echo 'Deployment storage lock is busy.' >&2; exit 1; }
python3 "$release_dir/release.py" > "$release_dir/driver.log" 2>&1
