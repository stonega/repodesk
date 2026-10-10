#!/usr/bin/env bash
# Credential-free verification on Debian 12 with Bun 1.3.14 and Node 24.
# System packages are downloaded/extracted locally; no sudo or service changes.
set -euo pipefail
cd "$(dirname "$0")/.."
verify_phase="${1:-all}"
case "$verify_phase" in
  all|quality|browser|release-browser|release-[123]-browser|runs-browser|navigation-browser) ;;
  *) echo "Usage: bash scripts/verify-skills.sh [all|quality|browser|release-browser|release-{1,2,3}-browser|runs-browser|navigation-browser]" >&2; exit 2 ;;
esac
bun install --frozen-lockfile
bun install --cwd services/code-truth --frozen-lockfile
verify_root="$PWD/node_modules/.cache/verify-skills"
mkdir -p "$verify_root/apt/lists/partial" "$verify_root/apt/archives/partial" "$verify_root/system"
# Some coding runners mount /tmp with noexec; subprocess fixtures need an
# executable temporary directory. Keep those fixtures in the ignored checkout.
# The host-updater smoke fixture accepts deployment paths without dots. Keep
# temporary fixtures outside .cache while retaining an executable ignored path.
export TMPDIR="$PWD/node_modules/verify-skills-tmp"
mkdir -p "$TMPDIR"
apt_options=(-o "Dir::State::lists=$verify_root/apt/lists" -o "Dir::Cache::archives=$verify_root/apt/archives" -o Debug::NoLocking=1)
if [[ ! -f "$verify_root/system/.ready" ]]; then
  apt-get "${apt_options[@]}" update
  apt-get "${apt_options[@]}" --download-only --yes --no-install-recommends install \
    postgresql-15 libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 \
    libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 \
    libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
    libxfixes3 libxkbcommon0 libxrandr2 fonts-liberation
  for package in "$verify_root"/apt/archives/*.deb; do
    # Keep the host libc paired with its loader.
    [[ $(basename "$package") == libc6_* ]] && continue
    dpkg-deb -x "$package" "$verify_root/system"
  done
  touch "$verify_root/system/.ready"
fi
export LD_LIBRARY_PATH="$verify_root/system/usr/lib/x86_64-linux-gnu:$verify_root/system/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PATH="$verify_root/system/usr/lib/postgresql/15/bin:$PATH"
export NO_PROXY="localhost,127.0.0.1${NO_PROXY:+,$NO_PROXY}"
export PLAYWRIGHT_BROWSERS_PATH="$verify_root/browsers"
# Supply the extracted fonts without modifying system font configuration.
cat > "$verify_root/fonts.conf" <<FONTCONFIG
<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>$verify_root/system/usr/share/fonts</dir><cachedir>$verify_root/font-cache</cachedir>
  <alias><family>system-ui</family><prefer><family>Liberation Sans</family></prefer></alias>
  <alias><family>sans</family><prefer><family>Liberation Sans</family></prefer></alias>
  <alias><family>sans-serif</family><prefer><family>Liberation Sans</family></prefer></alias>
  <alias><family>serif</family><prefer><family>Liberation Serif</family></prefer></alias>
  <alias><family>monospace</family><prefer><family>Liberation Mono</family></prefer></alias>
</fontconfig>
FONTCONFIG
export FONTCONFIG_FILE="$verify_root/fonts.conf"
bun x playwright install --only-shell chromium
verify_db=$(mktemp -d "$verify_root/postgres.XXXXXX")
cleanup() {
  pg_ctl -D "$verify_db/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$verify_db"
}
trap cleanup EXIT
# Fresh disposable cluster; trust is limited to loopback and its private socket.
initdb -D "$verify_db/data" -U postgres -A trust --no-locale >/dev/null
pg_ctl -D "$verify_db/data" -l "$verify_db/postgres.log" \
  -o "-h 127.0.0.1 -p 55439 -k $verify_db" -w start
export TEST_DATABASE_URL="postgres://postgres@127.0.0.1:55439/postgres"
if [[ "$verify_phase" != *browser ]]; then
  bun run --cwd services/code-truth typecheck
  bun run check
  bun run typecheck
  bun test
fi
bun run build
if [[ "$verify_phase" != *browser ]]; then
  bun run test:runtime
fi
if [[ "$verify_phase" == release-browser ]]; then
  bun run test:browser
elif [[ "$verify_phase" == release-[123]-browser ]]; then
  verify_shard="${verify_phase#release-}"
  bun run test:browser --shard="${verify_shard%-browser}/3"
elif [[ "$verify_phase" == runs-browser ]]; then
  bun run test:browser tests/browser/runs.e2e.ts tests/browser/admin.e2e.ts
elif [[ "$verify_phase" == navigation-browser ]]; then
  bun run test:browser tests/browser/sidebar.e2e.ts tests/browser/account.e2e.ts tests/browser/navigation-account.e2e.ts tests/browser/application-update.e2e.ts tests/browser/session-expiry.e2e.ts
elif [[ "$verify_phase" != quality ]]; then
  bun run test:browser tests/browser/skills-search.e2e.ts tests/browser/team-workflows.e2e.ts tests/browser/admin.e2e.ts
fi
