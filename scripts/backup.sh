#!/usr/bin/env bash
set -euo pipefail
umask 077
backup_dir="${BACKUP_DIR:-./backups}"
mkdir -p "$backup_dir"
backup_path="$backup_dir/deepx-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T postgres pg_dump -U deepx -d deepx --format=custom > "$backup_path"
printf 'Backup written: %s\nKeep the application encryption key in separate protected storage.\n' "$backup_path"
