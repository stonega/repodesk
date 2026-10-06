# Local Codex execution with Docker or Podman

The **Local containers** runner runs policy-authorized coding tasks on the deployment
host. Pi still
handles Telegram conversations; the coding service handles approval, identity,
task state and publication. Deployment starts the supervisor; individual tasks
start isolated containers when authorized.

The Codex detail page and configuration dialog explain automatic VPS startup and
link here for recovery. **Enabled** records workspace policy;
it does not mean a runner is installed, reachable or authenticated. Both sign-in
methods require the supervisor and a prebuilt task image.

## Configure the deployment

### Docker VPS releases (automatic)

Stable GitHub releases build and transfer the application, trusted Codex supervisor
and task images. The deploy script applies `deploy/codex/docker-compose.yaml`,
starts the supervisor, and waits for its engine, task-image and network readiness
before stopping application writers. Existing Docker databases and the Compose
project remain in place; no Podman installation or database migration is needed.
The supervisor restarts automatically after a host restart.

The first release generates a private management/encryption token at
`secrets/codex-runner-token` (mode 600). Later releases reuse it and the
`codex_runner_state` volume, preserving workspace account credentials. A previously
configured `CODEX_RUNNER_TOKEN` is adopted; mismatched tokens fail preflight rather
than silently replacing the key. Back up the token and runner volume together.
Release-local `codex.env` records this token, imported immutable image IDs and the
project's task-network name. It is generated on the host and never printed or
uploaded to GitHub. The app and worker receive the same management connection.

Only the trusted supervisor mounts `/var/run/docker.sock`; it can control the
host Docker daemon. Use this deployment on a trusted dedicated VPS. The supervisor
has `CHOWN` for preparing private auth files and disables SELinux container labeling
for socket access. A stopped, credential-free input copier populates a separate volume, which tasks
mount read-only. It runs no repository code and is removed after copying;
reconciliation also removes interrupted copiers. Task containers drop all
capabilities, receive no daemon socket,
and cannot join the application/database network. Runner HTTP is private with no
published port. The supervisor joins the application and separate task networks.

After deployment, enable Codex in the workspace, choose **ChatGPT device code**,
click **Sign in with device code**, and complete the displayed link/code. Existing
open dialogs can use **Recheck connection**. No runner setup fields or commands are
required in the panel. Manual deployments can merge the Docker overlay with the
base Compose file, specifying the two prebuilt images and a stable private token.
See [VPS deployment](vps-deployment.md) for release and recovery details.

### A new or existing Podman application stack

Install Podman and a Compose provider on the host first. Run the following as
the account that owns the application stack, images and task containers:

```sh
systemctl --user enable --now podman.socket
export PODMAN_SOCKET="${XDG_RUNTIME_DIR}/podman/podman.sock"
test -S "$PODMAN_SOCKET"
```

For operation after logout and reboot, the host administrator enables lingering
for this service account with `loginctl enable-linger ACCOUNT_NAME`. This keeps
the socket available; it does not create a permanent Codex task container. See
[Podman's system service documentation](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html).

Use a rootless Podman service with its Unix socket available to the supervisor.
The socket grants control of that Podman account; the supervisor is trusted
infrastructure. Task containers never receive the socket. A dedicated rootless
account is appropriate for a shared deployment.

Build the reusable task image from the repository root:

```sh
podman build --format=docker --target codex-job -t localhost/deepx-codex-job:local .
```

The image pins Codex CLI 0.155.1 and includes Node 24, Bun 1.3.14, Git and Bash.
Use a reviewed custom image based on this target if a repository needs additional
system tools. Set `CODEX_RUNNER_IMAGE` to its local tag; the runner never pulls
images supplied by a model or task. Build before starting tasks.

Set these variables in the deployment's private `.env` or Compose environment:

```dotenv
PODMAN_SOCKET=/run/user/1000/podman/podman.sock
CODEX_RUNNER_TOKEN=replace-with-a-random-token-of-at-least-32-characters
CODEX_PROVIDER_NAME=AIAPI
CODEX_PROVIDER_BASE_URL=https://aiapi.abmatrix.cn/v1
CODEX_MODEL=gpt-6-astra
CODEX_REASONING_EFFORT=high
```

The provider name, URL, model and effort above follow this device's Codex
configuration as inspected on 2026-09-22. That configuration uses
`model_provider = "proxy"`, `wire_api = "responses"`, and the environment key
`AIAPI_API_KEY`. Save your provider key in the workspace web panel as described
below. Do not copy an existing host `auth.json`, the entire host Codex home,
host plugins, or host credentials into images or task volumes. No key was copied
from the device.

The workspace operator selects **Custom provider API key** or **ChatGPT device
code** under **Plugins → Codex → Configuration → Edit**. Existing
workspaces default to the custom provider. The operator can set, replace or
remove that provider API key in the same panel. The app
stores it encrypted with `ENCRYPTION_KEY` and workspace-bound authenticated data.
The panel/API return only whether a key is configured, never its value. Saved
workspace keys take precedence over the optional supervisor environment fallback
`CODEX_PROVIDER_API_KEY`. Removing a saved key restores that fallback; without
either key, task start fails with `coding_provider_not_configured`.

The worker decrypts the workspace key only for the authenticated start request.
The supervisor keeps an encrypted task copy for restart recovery, protected by a
key derived from `CODEX_RUNNER_TOKEN` and task-bound authenticated data. It deletes
that copy when implementation finishes or the task stops. Drain active tasks
before rotating the runner token, since older task credentials then cannot decrypt.
Keys never enter job input, task volumes, container environment or command arguments,
build arguments, API responses or routine logs. The task's generated `config.toml` selects the custom Responses provider
through the supervisor proxy and uses `env_key = "CODEX_TASK_TOKEN"`. This
temporary token authorizes only model requests while that task is running; it
cannot call runner management endpoints. Setup and checks do not inherit it.

The supervisor explicitly installs system CA certificates for native Codex HTTPS
requests; its build and health checks verify the bundle. See the
[device-login incident](../../postmortem/2026-10-06-codex-device-auth-ca.md).
Login transport errors are reported separately from rejected or unavailable device
login, without exposing raw CLI output. Failed reauthentication preserves sealed
auth-required state for paused tasks. Cancellation terminates both the npm launcher
and native CLI in that login's isolated process group.

Operators can run **Actions → Diagnose Codex device login → Run workflow** to
probe the deployed runner's actual CLI and OpenAI auth connectivity. It uses a
fresh temporary Codex home, cancels the pending request, and removes that home.
It never reads existing account caches or prints device codes, credentials or
raw CLI output; logs contain only status codes and diagnostic flags.

For **ChatGPT device code**, save the authentication method, then select
**Sign in with device code**. Open the displayed OpenAI link, sign in and enter
the one-time code. Device login must be enabled in the account's ChatGPT
security settings or workspace permissions. The panel polls until connected;
**Disconnect account** removes the local cache and stops unfinished
implementation. The saved custom provider key stays unused in this mode.
ChatGPT sign-in uses Codex's built-in OpenAI provider and default model rather
than the deployment's custom provider model.

Both model authentication methods support connected public and private
repositories. Repository access uses fresh GitHub App installation tokens scoped
to the selected repository: read-only for preparation, issue-write for reviewed
issue creation, and contents/pull-request write for authorized publication.
ChatGPT account authentication does not grant GitHub access. Existing maintainer,
connected-repository and execution-policy checks apply independently of visibility.
Use this option only for trusted code:
Codex can access the account token cache while implementing. The supervisor
encrypts the per-workspace cache at rest using a key derived from
`CODEX_RUNNER_TOKEN`. It decrypts a copy into a short-lived per-task container
auth volume during the Codex phase, saves any refreshed cache on exit, and
removes that volume. Repository setup and checks use separate containers
without it. A disconnected workspace pauses before issue creation; no issue is created while waiting for sign-in. Rotating
`CODEX_RUNNER_TOKEN` invalidates stored device logins; reconnect afterward.
Do not copy a host `auth.json` into the deployment.

Account auth is owned by the persistent supervisor, not by a long-lived task
container. Sealed credentials include a generation; refreshed task copies can
update only the generation they received. A late exit cannot overwrite a new
login or restore a disconnected account. Existing sealed caches remain readable.
Drain active tasks from older builds before upgrading; their in-flight credential
copies do not carry a generation and cannot write back into the new cache.
On cancellation the runner stops Codex before capturing its final auth cache.

A final Codex authentication failure sets `deviceAuth.state` and task state to
`auth_required`. Transient retry events, quota and network errors do not invalidate
account auth. Tasks retain the same private checkout and fixed verification plan,
remove their auth volume and release the runner slot. The worker sends one sign-in
notice per pause. After reconnect, it rechecks permissions, connected GitHub
repository access before requesting idempotent `/resume-auth` on the same
runner task. It creates a fresh auth volume; it does not recreate the issue, checkout
or publication reservation. Questions and new inputs retain their original order.

Reported token usage is cumulative across resumes. A denied request before observed
model activity counts zero usage; missing reports after observed activity are marked
as unknown usage. They are not replaced with a configured allowance and do not
block authorized continuation. Stop, disconnect, access revocation and source expiry
prevent continuation. Local checkpoint retention still applies while waiting;
expired checkouts report `coding_checkpoint_expired` and require a new task.

Codex refreshes account tokens during normal use; the current upstream guidance
uses roughly eight days since last refresh as a refresh threshold. This is not a
fixed login expiry or a guarantee of indefinite validity. No scheduled model call
or permanent task container is required. See the [plan and recovery boundaries](codex-auth-plan.md).


After the shared runner token and existing application settings are configured,
validate and start from the repository root on that same Podman engine:

```sh
podman compose -f compose.yaml -f deploy/codex/compose.yaml config --quiet
podman compose -f compose.yaml -f deploy/codex/compose.yaml up --build -d
podman compose -f compose.yaml -f deploy/codex/compose.yaml ps codex-runner
```

Keep `CODEX_RUNNER_TOKEN` private and stable: it authenticates the app/worker
connection and protects saved account credentials. The overlay wires the private
runner URL and matching token into both app and worker. Once the supervisor is
healthy, return to **Plugins → Codex → Configuration → Edit → Recheck connection**.
Device-code sign-in should then become available. Sign in afterward; host startup
does not connect a ChatGPT account.

The supervisor joins the app network and a separate task network. Task containers
join only the task network, have no published ports, run as UID 1000 with a
read-only root filesystem, dropped capabilities and process/CPU/memory limits.
Outbound access is needed for GitHub, packages and the
configured provider. The Podman overlay requires a **Podman** engine even when
using `docker compose` for configuration validation. The ordinary app still
also supports the Docker coding overlay used by VPS releases.

Only the app and worker get `CODEX_RUNNER_URL` and `CODEX_RUNNER_TOKEN`. Only the supervisor
gets the optional provider environment fallback and Podman socket. No bot, database
or GitHub App private key is mounted into coding containers. The supervisor HTTP port is not published.

## Configure repositories

1. Connect the GitHub App and repository as described in [GitHub setup](github-app.md).
2. For local publication, grant the App **Contents: read and write**, **Issues:
   read and write**, and **Pull requests: read and write**, then approve the
   installation's permission update. No Actions permission is needed.
3. Under **Plugins → Codex → Repositories**, add the repository's base branch
   and maintainers. Codex discovers environment preparation and relevant tests
   automatically from repository instructions; no command configuration is needed.
4. Open **Configuration → Edit** to save the workspace provider key or complete
   device-code sign-in, then enable Codex.

Repository identity, maintainers and publication policy are operator configuration. Codex
chooses a bounded verification plan (one to eight commands, at most 2000 characters
each), including required preparation for credential-free replay. The runner freezes
that plan for repairs and runs it in the check container without model/GitHub
credentials. Patch integrity is always checked too. A missing/invalid plan or failed
verification prevents publication. Old command overrides are discarded; migration
013 removes them from persisted repository settings and invalidates old grants.

## Lifecycle and recovery

Each approved task gets a tenant-scoped name, private work volume, checkout and
Codex thread. The supervisor permits one active task at a time; additional
approved tasks wait. An initial preparation container receives only a
repository-scoped read token and pins the base commit. The implementation
container lets Codex prepare the environment and implement without a GitHub token.
A separate container replays the captured verification plan without model or GitHub credentials.
The workspace survives container exit in the task volume. Custom provider Codex
sessions survive there too; device-code auth and sessions in the temporary auth
volume are removed after implementation.

After checks pass, a credential-free export container reads a size-limited patch.
An interrupted export can be recreated because it only reads the work volume and
has no network or credentials.
The worker rechecks actor, repository, configuration and deployment permissions
after minting a fresh repository-scoped publication token. A new container with a
fresh volume applies the patch, rejects `.github/` changes, commits, pushes a unique
task branch and creates a draft PR. It never runs repository scripts. There is no
automatic merge. Publication has its own durable reservation and is never blindly
retried after an uncertain response.

Custom provider spend is separate from Pi chat budgets. Device-code runs use
the connected ChatGPT account's Codex entitlements. Defaults are one active task,
2 CPUs, 4 GiB RAM and 256 processes; tune the
documented `CODEX_RUNNER_*` environment variables in `.env.example`. Patches are
limited to 5 MiB. Retained workspaces and sessions are removed after 24 hours
(configurable 1–168 hours); stopped containers and volumes are also removed.
Small task tombstones prevent replay of delayed duplicate submissions. Container
volumes consume host disk, so provision storage for the configured retention.

Stop and access revocation cancel local execution without requiring GitHub
credentials. A stop during publication reports an unknown outcome because a push
or PR may already exist. Workspace deletion does not undo remote writes; abandoned
local work is cancelled and cleaned by the supervisor. The worker also disconnects
and removes that workspace's sealed device credential after deletion; if the
supervisor is temporarily unavailable, it retries on the next maintenance pass.
Codex tasks have no execution-cycle, repair-count, active-time or token quotas.
Docker and Podman jobs have no application deadline or container watchdog.
Keep the supervisor running for cancellation, reconciliation and cleanup.
A restart observes existing containers by their
deterministic names, without launching duplicate work.

For an **unknown** outcome, inspect the matching task branch, issue and PR before
starting another request. A reserved container with an uncertain start is reconciled
by its deterministic identity; it is not recreated blindly.
Encrypted active-task credentials, temporary task tokens and reviewed
task content are private supervisor state. Replacing the
supervisor state volume loses recovery information and must not be used to retry
tasks automatically.

Continuous tasks use a private stdin/stdout Codex app-server adapter alongside
legacy reviewed `codex exec` tasks. CLI 0.155.1 is unchanged. Completed-turn
`needs_input` results checkpoint questions; no connection-local question ID or live
steering acknowledgement is treated as durable. The allowlist is initialize,
initialized, thread/start, thread/resume and turn/start. Relevant notifications are
turn/started, item/completed, thread/tokenUsage/updated and turn/completed. Unsupported
server requests are rejected; process cancellation interrupts active execution.
JSONL frames are capped at 4 MiB and final envelopes at 60000 UTF-8 bytes. Model
reasoning and raw protocol streams are not routine logs.

Run `bun scripts/codex-protocol-proof.ts` to verify the pinned real CLI against a
local fake Responses provider: current-input intake evidence constraints,
structured questions, continuation, missing-session
reconstruction, per-turn token accounting and cancellation. It creates a clean
Codex home and uses no host auth or paid model calls. The fixture passed both on
the host and bundled inside the read-only job image with no external network.
The real Docker/Podman smoke also covers question checkpoints, automatic repair/repair
exhaustion, fresh and same-PR publication with fake GitHub, remote-head fencing,
device continuation and explicit private-state erasure. Waiting releases the global
runner slot. Retained work checkpoints can seed a new isolated cycle; expired
checkpoints reconstruct from authorized context. See [continuous setup](codex-coding.md).
Local checks do not establish live model intent quality or live publication; the
staging journey remains a release gate.

For a repeatable smoke test without model calls or GitHub writes, build the
`codex-job` and `codex-supervisor` targets with the `:verify` tags, then run
`bun scripts/codex-smoke.ts`. It substitutes a local Git fixture and fake Codex
executable while exercising the real supervisor, engine socket, resource limits,
volumes, patch export and cancellation, and removes its test resources afterward.
`CODEX_SMOKE_JOB_IMAGE` and `CODEX_SMOKE_SUPERVISOR_IMAGE` can select other tags.
Set `CODEX_SMOKE_ENGINE=docker` for Docker (the default remains Podman).
`CODEX_SMOKE_DOCKER_SOCKET` or `CODEX_SMOKE_PODMAN_SOCKET` selects the engine socket.
CI and release builds run the full Docker fixture.
When a host HTTP proxy is configured, exempt localhost with `NO_PROXY`/`no_proxy`
for tests; a loopback-only build proxy may need `podman build --network=host`.

Official references: [Codex device login](https://learn.chatgpt.com/docs/auth#login-on-headless-devices),
[automation auth guidance](https://learn.chatgpt.com/docs/non-interactive-mode#authenticate-in-automation),
[Codex custom providers](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers),
[non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode),
[Podman run](https://docs.podman.io/en/latest/markdown/podman-run.1.html).
