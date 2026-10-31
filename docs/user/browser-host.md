# Install the Browser host

The API, worker and database keep their Docker deployment. Browser runs as a
separate systemd service on the Linux VPS and uses its existing Chrome/Chromium.
It needs Node 22.19+, Chrome/Chromium with its sandbox, Xvfb, xauth, D-Bus tools,
nftables, passwd tools and procps. Provision those host dependencies explicitly.

## Package and install

Build a fresh package from the same source revision as the application:

```sh
bun install --frozen-lockfile
bun deploy/browser/package.ts /tmp/repodesk-browser-package
```

Transfer that directory to the VPS. Review its installer and systemd unit, then
install using the actual browser executable and application secrets directory:

```sh
sudo BROWSER_EXECUTABLE=/usr/bin/google-chrome bash \
  /tmp/repodesk-browser-package/install.sh \
  /tmp/repodesk-browser-package /srv/repodesk/secrets
```

Use `/usr/bin/chromium` when appropriate. Installation validates checksums,
preserves an existing host token/settings/profiles, and enables/restarts
`repodesk-browser.service`. It does not connect website accounts or register
Telegram webhooks. Update the application, Codex supervisor/job images and host
package together when their browser protocol changes.

The root supervisor creates locked per-owner Linux accounts, private homes and
authenticated virtual displays. Browser workers run under their own account,
with Chrome's sandbox enabled. There is no headless fallback or TCP debugging
port. nftables limits each browser UID to its authenticated local proxy; it
cannot connect directly to arbitrary host services or bypass the proxy using
DNS, UDP or WebRTC.

## Connect Docker services

Review `/etc/repodesk/browser.env` and retain the root-owned host token. Mount only
the private socket directory and the application token copy into API/worker:

```sh
export BROWSER_TOKEN_FILE=/srv/repodesk/secrets/browser-token
docker compose -f compose.yaml -f compose.browser.yaml config --quiet
```

Use that merged configuration for the normal deployment. It sets
`BROWSER_HOST_SOCKET=/run/repodesk-browser/control.sock` and
`BROWSER_HOST_TOKEN_FILE=/run/secrets/browser_token` in API/worker. The optional
overlay also routes Codex's task-scoped broker requests to `http://app:3000`.
Set `BROWSER_CODEX_ORIGIN` to another application origin if the supervisor cannot
reach that Docker service address. Without it, the current public site origin is
used. Codex jobs receive only their attempt's channel access; the host key/socket
and browser profiles are not mounted into jobs.

The socket directory is mounted instead of the socket inode so a service restart
can replace the socket. Its default application GID is `1000`. If your deployment
uses another GID, change `BROWSER_HOST_SOCKET_GID`, token ownership and Compose
`group_add` consistently. Do not mount profile directories, host `/` or the host
Docker socket into the application for this feature.

Configure the bot's main Mini App URL as the deployment's HTTPS `/mini` URL. It
serves both task history and [personal Browser interactions](browser.md). Member
identity comes from server-verified Telegram initialization data.

## Operation and recovery

```sh
sudo systemctl status repodesk-browser
sudo journalctl -u repodesk-browser
```

Logs contain fixed diagnostic codes rather than passwords, page bodies or raw
browser output. An unavailable service affects Browser operations; ordinary
greetings do not contact the service or read its optional token file.

The default root is `/var/lib/repodesk-browser`; code is installed under
`/opt/repodesk-browser`. The unit limits the cgroup to 2 GiB and 512 tasks.
`BROWSER_HOST_MAX_PROCESSES` defaults to four and `BROWSER_HOST_IDLE_SECONDS` to
300. Tune memory and concurrency together. Add a filesystem quota for a hard
disk limit: website caches/storage can grow independently of download limits.

Profiles retain login over idle shutdown and service restart. Session cookies
also have an encrypted root-owned checkpoint. Normal site logout replaces that
checkpoint. Closing preserves login; deleting the profile clears cookies and
files. Account deletion/revocation cleanup remains pending while the host is
unavailable and retries when it reconnects. Reserved browser UIDs/firewall rules
must not be manually reassigned.

Back up the host state with its root-only host key if restoring browser login is
required. Protect the application's database encryption key separately. Restored
browser profiles are sensitive account access; use the same access and retention
policy as other credentials. Replacing the host key without migrating existing
checkpoints makes those checkpoints unreadable.

If Chrome cannot start with its sandbox or display, repair the host prerequisites.
The service reports unavailability instead of falling back to headless mode or
disabling the sandbox. Systemd shutdown revokes proxy access first and terminates
the whole service process group. See [maintenance](maintenance.md) for the rest of
the application backup and upgrade workflow.
