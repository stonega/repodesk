#!/usr/bin/env bash
set -euo pipefail
umask 077
release_dir="${1:?Missing release directory}"
[[ "$release_dir" =~ ^/opt/repodesk/releases/[0-9]+-[0-9]+$ ]]
[[ "$(cat "$release_dir/stage")" == deployment_verified ]]
[[ "$(cat "$release_dir/deploy.exit")" == 0 ]]
python3 - <<'PY'
from pathlib import Path
import os
p=Path('/etc/systemd/system/repodesk-browser.service.d/socket.conf')
p.write_text('[Service]\nRuntimeDirectoryPreserve=yes\n');os.chmod(p,0o644)
PY
systemctl daemon-reload
before=$(stat -c '%d:%i' /run/repodesk-browser)
systemctl restart repodesk-browser
for attempt in {1..120}; do
 if [[ -S /run/repodesk-browser/control.sock && "$(stat -c %a /run/repodesk-browser/control.sock)" == 660 ]]; then break; fi
 sleep 0.25
done
[[ "$before" == "$(stat -c '%d:%i' /run/repodesk-browser)" ]]
for container in repodesk-app-1 repodesk-worker-1; do
 docker exec -i "$container" node --input-type=module < "$release_dir/host-probe.mjs"
done
python3 - "$release_dir" <<'PY'
import datetime,json,os,sys,hashlib
from pathlib import Path
root=Path(sys.argv[1]);p=root/'deployment-receipt.json';r=json.loads(p.read_text());r['browser_host']['socketDirectoryPreservedOnRestart']=True;r['browser_host']['existingApiAndWorkerMountsVerified']=True;r['browser_host']['restartVerifiedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();r['browser_host']['socketUnitOverrideSha256']=hashlib.sha256(Path('/etc/systemd/system/repodesk-browser.service.d/socket.conf').read_bytes()).hexdigest();p.write_text(json.dumps(r,indent=2)+'\n');os.chmod(p,0o600)
failed=root/'failure.json'
if failed.exists():failed.rename(root/'failure-before-verification.json')
print(json.dumps({'apiSurvivesHostRestart':True,'workerSurvivesHostRestart':True}))
PY
