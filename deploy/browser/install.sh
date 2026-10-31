#!/usr/bin/env bash
set -euo pipefail
umask 077

# Explicit operator action on the Linux VPS, after reviewing the package.
# Never called by application startup or a model tool.
if [[ ${EUID} != 0 || $# != 2 ]]; then
  echo 'Usage: sudo bash install.sh PACKAGE_DIRECTORY APP_SECRET_DIRECTORY' >&2
  exit 1
fi
package_dir=$(realpath -- "$1")
secret_dir=$(realpath -m -- "$2")
[[ $package_dir = /* && $secret_dir = /* ]]
for binary in node systemctl Xvfb xauth dbus-run-session nft useradd getent pkill; do
  command -v "$binary" >/dev/null
done
browser_executable=${BROWSER_EXECUTABLE:-/usr/bin/google-chrome}
[[ -x $browser_executable ]]
node --input-type=commonjs - "$package_dir" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) throw Error('Node 22.19+ required');
const root = process.argv[2];
const files = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
for (const [name, digest] of Object.entries(files)) {
  if (name.split('/').some(x => !x || x === '..') || path.isAbsolute(name)) throw Error('Invalid manifest path');
  const file = path.join(root, name);
  if (fs.lstatSync(file).isSymbolicLink()) throw Error('Invalid package link');
  if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== digest) throw Error('Package checksum mismatch');
}
NODE
install -d -m 0755 /opt/repodesk-browser
if [[ ! -d /etc/repodesk ]]; then
  install -d -m 0700 /etc/repodesk
fi
[[ ! -L /etc/repodesk && $(stat -c %u /etc/repodesk) == 0 ]]
directory_mode=$(stat -c %a /etc/repodesk)
(( (8#$directory_mode & 8#022) == 0 ))
[[ ! -L /etc/repodesk/browser-token && ! -L /etc/repodesk/browser.env ]]
cp -R -- "$package_dir/." /opt/repodesk-browser/
chown -R root:root /opt/repodesk-browser
chmod -R go-w /opt/repodesk-browser
if [[ ! -f /etc/repodesk/browser-token ]]; then
  node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("hex"))' > /etc/repodesk/browser-token
fi
[[ ! -L /etc/repodesk/browser-token ]]
chown root:root /etc/repodesk/browser-token
chmod 0600 /etc/repodesk/browser-token
if [[ ! -f /etc/repodesk/browser.env ]]; then
  # Container application runs as UID/GID 1000. Change both the service setting
  # and Compose group_add when deploying with another GID.
  printf '%s\n' \
    'BROWSER_HOST_ROOT=/var/lib/repodesk-browser' \
    'BROWSER_HOST_SOCKET=/run/repodesk-browser/control.sock' \
    'BROWSER_HOST_SOCKET_GID=1000' \
    'BROWSER_HOST_TOKEN_FILE=/etc/repodesk/browser-token' \
    "BROWSER_EXECUTABLE=$browser_executable" \
    'BROWSER_HOST_MAX_PROCESSES=4' \
    'BROWSER_HOST_IDLE_SECONDS=300' > /etc/repodesk/browser.env
fi
[[ ! -L /etc/repodesk/browser.env ]]
chown root:root /etc/repodesk/browser.env
chmod 0600 /etc/repodesk/browser.env
if [[ ! -d $secret_dir ]]; then
  install -d -o 1000 -g 1000 -m 0700 "$secret_dir"
fi
install -o 1000 -g 1000 -m 0600 /etc/repodesk/browser-token "$secret_dir/browser-token"
install -o root -g root -m 0644 /opt/repodesk-browser/repodesk-browser.service /etc/systemd/system/repodesk-browser.service
systemctl daemon-reload
systemctl enable repodesk-browser.service
systemctl restart repodesk-browser.service
echo 'Browser host installed. Existing token and profiles were preserved.'
