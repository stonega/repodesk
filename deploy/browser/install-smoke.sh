#!/usr/bin/env bash
set -euo pipefail
# This fixture writes only inside a fresh, disposable Docker test container.
[[ -f /.dockerenv && ${EUID} == 0 && ! -e /etc/repodesk/browser-token ]]
[[ -f /opt/repodesk/manifest.json ]]
mkdir -p /tmp/browser-test-bin
cat > /tmp/browser-test-bin/systemctl <<'STUB'
#!/bin/sh
case "$1" in daemon-reload|enable|restart) exit 0;; *) exit 1;; esac
STUB
chmod +x /tmp/browser-test-bin/systemctl
export PATH="/tmp/browser-test-bin:$PATH"
bash /opt/repodesk/install.sh /opt/repodesk /application-secrets
cp /etc/repodesk/browser-token /tmp/browser-original-token
printf '\nBROWSER_HOST_MAX_PROCESSES=2\n' >> /etc/repodesk/browser.env
mkdir -p /var/lib/repodesk-browser/profiles/retained
printf 'synthetic profile' > /var/lib/repodesk-browser/profiles/retained/fixture
bash /opt/repodesk/install.sh /opt/repodesk /application-secrets
node --input-type=commonjs <<'NODE'
const fs = require('node:fs'), assert = require('node:assert/strict');
assert.ok(fs.readFileSync('/tmp/browser-original-token').equals(fs.readFileSync('/etc/repodesk/browser-token')));
assert.ok(fs.readFileSync('/etc/repodesk/browser-token').equals(fs.readFileSync('/application-secrets/browser-token')));
assert.equal(fs.statSync('/etc/repodesk/browser-token').mode & 0o777, 0o600);
assert.equal(fs.statSync('/etc/repodesk/browser-token').uid, 0);
assert.equal(fs.statSync('/application-secrets/browser-token').uid, 1000);
assert.equal(fs.statSync('/application-secrets').uid, 1000);
assert.equal(fs.statSync('/etc/repodesk/browser.env').mode & 0o777, 0o600);
assert.ok(fs.readFileSync('/etc/repodesk/browser.env', 'utf8').includes('BROWSER_HOST_MAX_PROCESSES=2'));
assert.equal(fs.readFileSync('/var/lib/repodesk-browser/profiles/retained/fixture', 'utf8'), 'synthetic profile');
process.stdout.write(JSON.stringify({installer:true,preservedToken:true,preservedSettings:true,preservedProfiles:true})+'\n');
NODE
