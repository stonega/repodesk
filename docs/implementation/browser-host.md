# Native Browser host

Status: native implementation and isolated verification, updated 2026-10-31.
Application, member-page and chat/Codex/file-plugin adapters are implemented on the
working branch; completed local checks are tracked in [Browser implementation](browser.md).
No production installation or account connection is implied.

## Process and permission boundary

The API and worker remain in Docker. A root supervisor on a Linux VPS accepts
HMAC-authenticated requests over a private Unix socket. It creates one locked
system account, home directory and Xvfb display per workspace/verified Telegram
actor. Chrome and its automation worker run under that account, with Chrome's
sandbox explicitly enabled. Browsers receive a minimal environment, not deployment
credentials. There is no listening browser debugging port or headless fallback.

Each profile uses its own authenticated loopback proxy. nftables restricts the
browser UID to that proxy; direct TCP, DNS, UDP and WebRTC bypass are denied. The
proxy requires exact authorized web origins, validates every DNS answer and pins
the outbound connection to that IP. Private, local and metadata destinations are
denied; an explicitly granted preview can reach its exact loopback origin only.
Redirect, login-provider and asset origins require their own grants. Revocation
closes existing tunnels and rejects requests that were still resolving DNS.
Network authority expires after 120 seconds without an authorized operation.
These controls restrict destinations; a site's own requests are not a guarantee
that visiting that site has no side effects.

Root ownership is required for managed UIDs and firewall rules. Root operators,
host backups and a compromised operating system remain trusted infrastructure;
application administrator status must not grant personal browser access.

Control journals persist generation, controller and request nonce receipts, never
page bodies or input values. An interrupted operation has an unknown outcome and
is not automatically replayed. Chrome retains its private profile. Session cookies
that Chrome normally discards on exit are additionally checkpointed with authenticated
encryption under the host key and owner-bound AAD. A successful logout replaces
the old checkpoint, so restarting does not restore the old login. Profile deletion
removes both the profile home and cookie checkpoint. The locked system account and
deny firewall rule remain reserved; their UID must not be reassigned manually.

Raw input travels only through the authorized private request and worker IPC.
Task-bound input must match the current page, origin, revision and controller.
It also retains the original DOM element and field attributes; replacing a field
with the same selector cannot redirect a late input submission. Sensitive input
currently supports same-origin fields; cross-origin iframe fields are refused.
Screenshots and downloads use owner-local UUID references; retrieval also requires
the originating site's current authorization. Files cannot be fetched by server
path. File choosers are intercepted with no uploaded files; keyboard tools expose
editing/navigation keys rather than browser, developer-tool or filesystem shortcuts.

## Package and install

The explicit `playwright-core` runtime dependency supplies Chrome automation
without downloading another browser at application startup. The version is pinned
to match the existing Playwright tooling. Chrome/Chromium, Node 22.19+, Xvfb, xauth,
D-Bus tools, nftables, passwd tools and procps are operator-provisioned host
dependencies. The service intentionally fails when the display, sandbox or host
capabilities are unavailable.

From the repository, create a fresh package directory:

```sh
bun install --frozen-lockfile
bun deploy/browser/package.ts /tmp/repodesk-browser-package
```

The package contains the two Node entry points, only their runtime dependencies,
the service/installer and a SHA-256 file manifest. Transfer it to the VPS and review
the installer and service. On the VPS, installation is an explicit operator action:

```sh
sudo BROWSER_EXECUTABLE=/usr/bin/google-chrome bash \
  /tmp/repodesk-browser-package/install.sh \
  /tmp/repodesk-browser-package /srv/repodesk/secrets
```

Use `/usr/bin/chromium` for a compatible system Chromium installation. The installer
checks prerequisites and package checksums, places root-owned code under
`/opt/repodesk-browser`, creates a root-only `/etc/repodesk/browser-token`, and writes
an application-readable copy to the requested secrets directory. Existing host
tokens, settings and profile data are preserved. It enables and restarts only the
Browser host service. It does not configure accounts, Telegram or webhooks.

Review `/etc/repodesk/browser.env` before production use:

| Setting | Default |
| --- | --- |
| `BROWSER_HOST_ROOT` | `/var/lib/repodesk-browser` |
| `BROWSER_HOST_SOCKET` | `/run/repodesk-browser/control.sock` |
| `BROWSER_HOST_TOKEN_FILE` | `/etc/repodesk/browser-token` |
| `BROWSER_HOST_SOCKET_GID` | `1000` |
| `BROWSER_EXECUTABLE` | `/usr/bin/google-chrome` |
| `BROWSER_HOST_MAX_PROCESSES` | `4` |
| `BROWSER_HOST_IDLE_SECONDS` | `300` |

The socket directory is root-owned, mode `0750`, with the configured application
GID; the socket is `0660`. Mount the directory, rather than a socket inode, so
service restarts can replace the socket. `compose.browser.yaml` adds that read-only
directory mount and a token secret to API/worker without adding a browser container.
The application uses that private bridge. Validate the merged file with:

```sh
docker compose -f compose.yaml -f compose.browser.yaml config --quiet
```

Set `BROWSER_TOKEN_FILE` to the application token copy and retain the existing
database/encryption settings. If the application GID differs from `1000`, update
the service setting, token ownership and Compose `group_add` consistently. Never
mount a host browser profile or the host root filesystem into the API/worker.

The systemd unit bounds the service cgroup to 2 GiB and 512 tasks, disables core
dumps, gives the service a private `/tmp`, and kills its complete cgroup on stop.
Tune process/memory limits together for the actual VPS. Profile directories have
no filesystem quota automatically configured; use an operator-managed filesystem
quota for a hard disk bound. Browser-controlled caches and website storage can
consume disk independently of accepted downloads. Do not disable Chrome's sandbox
to work around host compatibility problems.

## Retention and failure behavior

Browsers idle down after five minutes while preserving login/profile data. A
pending input request keeps its process alive for up to ten minutes. The host caps
tabs at eight, concurrent/stored downloads at twenty, and each accepted download
at 25 MiB; Chrome download-progress events cancel an oversized transfer before
acceptance. Screenshots retain the latest fifty references. Artifact reads expire
after 24 hours; file pruning happens on subsequent artifact writes or profile
deletion, so reference expiry is not immediate physical erasure from an idle disk.

The service revokes the proxy before process cleanup, attempts all cleanup steps
even if one fails, and records fixed diagnostic codes with verified workspace,
controller and request IDs. It excludes input values, URLs, browser stdout/stderr
and raw upstream errors. `journalctl -u repodesk-browser` contains service readiness
and these sanitized failures. A systemd stop kills remaining child processes.

Back up the private state and the root-only host key together if login recovery is
required; protect the application encryption key separately for the database.
Replacing the host key without migrating its cookie checkpoints makes existing
checkpoints unreadable. Key rotation and backup retention need an operator policy.

## Isolated verification

`deploy/browser/smoke.Dockerfile` runs the actual host code inside an isolated Linux
test container; it is not the production deployment topology. The fixture uses
synthetic accounts and a loopback site only. Its extra capabilities permit a real
Chrome sandbox and nftables inside that test namespace, without changing the
developer host's users or firewall:

```sh
docker build -f deploy/browser/smoke.Dockerfile -t repodesk-browser-host:smoke .
docker run --rm --init --cap-add NET_ADMIN --cap-add SYS_ADMIN \
  --security-opt seccomp=unconfined --memory 2g --cpus 2 \
  --pids-limit 512 --shm-size 512m repodesk-browser-host:smoke
docker run --rm --network none --env BROWSER_EXECUTABLE=/usr/bin/chromium \
  --entrypoint bash repodesk-browser-host:smoke /opt/repodesk/install-smoke.sh
```

The smoke contract checks actual process arguments, separate UIDs/homes/displays,
session isolation and restart/logout behavior, secure input, controller fencing,
artifact ownership, stale field replacement, proxy bypass denial and the packaged
host entry point. WebSockets and service workers remain available behind the same
egress boundary. Node runtime checks additionally exercise proxy upgrades with Node's
real HTTP/socket implementation. These native checks complement the separate application/API/UI and real Codex
protocol fixtures; they do not constitute a live website-account demonstration.

The separate installer fixture replaces `systemctl` inside a fresh disposable
container. It checks package validation, permissions and preservation of the
token, settings and profile data across reinstallation; it does not claim that a
real systemd deployment was started or verified on a VPS.

Implementation references: [Playwright persistent context](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context),
[Chromium Browser protocol](https://chromedevtools.github.io/devtools-protocol/tot/Browser/),
[systemd execution settings](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html),
and [systemd process cleanup](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html).
