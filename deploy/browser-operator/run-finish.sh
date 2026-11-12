#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
release_dir="$(cd "$(dirname "$0")" && pwd)"
trap 'result=$?; printf "%s\n" "$result" > "$release_dir/deploy.exit"' EXIT
exec 8>/opt/repodesk/.storage.lock
flock -n 8
python3 "$release_dir/finish.py" "$release_dir" > "$release_dir/finish-driver.log" 2>&1
