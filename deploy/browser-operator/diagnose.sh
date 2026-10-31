#!/usr/bin/env bash
set -euo pipefail
umask 077
release_dir="${1:?Missing release directory}"
[[ "$release_dir" =~ ^/opt/repodesk/releases/[0-9]+-[0-9]+$ ]]
DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get -o DPkg::Lock::Timeout=180 install -y --no-install-recommends strace > "$release_dir/trace-install.log" 2>&1
host_pid=$(systemctl show -p MainPID --value repodesk-browser)
[[ "$host_pid" =~ ^[1-9][0-9]*$ ]]
grep -E '^(Uid|Gid|CapEff|NoNewPrivs):' "/proc/$host_pid/status"
printf 'host network: '; readlink /proc/1/ns/net
printf 'service network: '; readlink "/proc/$host_pid/ns/net"
timeout 15 strace -f -e trace=execve,exit_group -s 160 -p "$host_pid" -o "$release_dir/host-command.trace" > "$release_dir/trace-attach.log" 2>&1 &
tracer_pid=$!
sleep 1
app_image=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["app"]["id"])' "$release_dir/build-images.json")
docker run --rm --network host --group-add 1000 \
  --volume /run/repodesk-browser:/run/repodesk-browser:ro \
  --volume /opt/repodesk/secrets/browser-token:/run/secrets/browser_token:ro \
  --volume "$release_dir/host-probe.mjs:/app/host-probe.mjs:ro" \
  --entrypoint node "$app_image" /app/host-probe.mjs > "$release_dir/trace-native-probe.log" 2>&1 || true
wait "$tracer_pid" || true
python3 - "$release_dir/host-command.trace" <<'PY'
import json,re,sys
from pathlib import Path
programs={}
for line in Path(sys.argv[1]).read_text().splitlines():
 m=re.search(r'^\s*(\d+)\s+execve\("([^"]+)".*= 0$',line)
 if m:programs[m[1]]=Path(m[2]).name
 m=re.search(r'^\s*(\d+)\s+exit_group\((\d+)\)',line)
 if m and programs.get(m[1]) in {'getent','useradd','nft','pkill','xauth','Xvfb','dbus-run-session'}:
  print(json.dumps({'command':programs[m[1]],'exit':int(m[2])}))
PY
