#!/usr/bin/env bash
set -euo pipefail
umask 077
release_dir="${1:?Missing release directory}"
[[ "$release_dir" =~ ^/opt/repodesk/releases/[0-9]+-[0-9]+$ ]]
exec 8>/opt/repodesk/.storage.lock
flock -n 8
[[ "$(cat "$release_dir/deploy.exit")" == 1 ]]
python3 - "$release_dir" <<'PY'
import json,subprocess,sys,re
from pathlib import Path
r=Path(sys.argv[1]);m=json.loads((r/'source-metadata.json').read_text());previous=m['previous_release_id'];assert re.fullmatch(r'[0-9]+-[0-9]+',previous);assert Path('/opt/repodesk/.current-release').read_text().strip()==previous
backup=Path('/opt/repodesk/backups')/('pre-release-'+m['release_id']+'.dump');assert backup.stat().st_size>0
with backup.open('rb') as f:subprocess.run(['docker','exec','-i','repodesk-postgres-1','pg_restore','--list'],stdin=f,stdout=subprocess.DEVNULL,check=True)
(r/'recovery-previous-release').write_text(previous+'\n')
for name in ['repodesk-app-1','repodesk-worker-1']:
 p=subprocess.run(['docker','logs','--tail','100',name],capture_output=True,text=True)
 (r/(name+'-failed-startup.log')).write_text(p.stdout+p.stderr)
 for line in (p.stdout+p.stderr).splitlines():
  try:
   x=json.loads(line)
   safe={k:x[k] for k in ['service','level','event','code','error_code'] if k in x and isinstance(x[k],str) and re.fullmatch(r'[a-zA-Z0-9_:. -]{1,100}',x[k])}
   if safe:print(json.dumps({'container':name,**safe}))
  except (ValueError,TypeError):pass
PY
previous=$(cat "$release_dir/recovery-previous-release")
old="/opt/repodesk/releases/$previous"
compose=(docker compose --project-directory /opt/repodesk -p repodesk --env-file /opt/repodesk/.env --env-file "$old/release.env" --env-file "$old/codex.env" -f "$old/compose.yaml" -f "$old/codex-compose.yaml")
"${compose[@]}" config --quiet
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 180 codex-runner code-truth
"${compose[@]}" up -d --no-deps --no-build --pull never --wait --wait-timeout 180 app worker
for attempt in {1..60}; do
 if curl -fsS --max-time 5 http://127.0.0.1:3000/readyz; then printf '\nPrevious application restored; additive migration retained.\n'; exit 0; fi
 sleep 1
done
exit 1
