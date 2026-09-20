#!/usr/bin/env bash
set -euo pipefail
# Restore into a disposable sibling database; never overwrites the application DB.
rehearsal_dump="${1:?Usage: restore-rehearsal.sh PATH_TO_DUMP}"
rehearsal_db="deepx_restore_$(date -u +%s)_$$"
cleanup() { docker compose exec -T postgres dropdb -U deepx --if-exists "$rehearsal_db" >/dev/null; }
trap cleanup EXIT
docker compose exec -T postgres createdb -U deepx "$rehearsal_db"
docker compose exec -T postgres pg_restore -U deepx -d "$rehearsal_db" --no-owner --exit-on-error < "$rehearsal_dump"
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U deepx -d "$rehearsal_db" -c 'SELECT count(*) AS migrations FROM schema_migrations; SELECT count(*) AS deployments FROM deployment; SELECT count(*) AS workspaces FROM workspaces;'
printf 'Restore rehearsal passed in disposable database %s.\n' "$rehearsal_db"
