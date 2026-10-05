# Local Codex execution with Podman

The **Local Podman** runner runs policy-authorized coding tasks on the deployment
host. Pi still
handles Telegram conversations; the coding service handles approval, identity,
task state and publication. Enabling the plugin does not start a coding container.

## Configure the deployment

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

For **ChatGPT device code**, save the authentication method, then select
**Sign in with device code**. Open the displayed OpenAI link, sign in and enter
the one-time code. Device login must be enabled in the account's ChatGPT
security settings or workspace permissions. The panel polls until connected;
**Disconnect account** removes the local cache and stops unfinished
implementation. The saved custom provider key stays unused in this mode.
ChatGPT sign-in uses Codex's built-in OpenAI provider and default model rather
than the deployment's custom provider model.

Device sign-in is limited to connected repositories whose GitHub metadata
confirms they are **private**. The worker checks visibility again through GitHub
before issue creation and again before starting the local implementation.
Reconnect GitHub if an older repository entry
lacks visibility metadata. Use this option only for trusted private code:
Codex can access the account token cache while implementing. The supervisor
encrypts the per-workspace cache at rest using a key derived from
`CODEX_RUNNER_TOKEN`. It decrypts a copy into a short-lived per-task Podman
auth volume during the Codex phase, saves any refreshed cache on exit, and
removes that volume. Repository setup and checks use separate containers
without it. A disconnected workspace fails before issue creation. Rotating
`CODEX_RUNNER_TOKEN` invalidates stored device logins; reconnect afterward.
Do not copy a host `auth.json` into the deployment.

Validate and start when ready to deploy:

```sh
docker compose -f compose.yaml -f deploy/codex/compose.yaml config --quiet
podman compose -f compose.yaml -f deploy/codex/compose.yaml up --build -d
```

The supervisor joins the app network and a separate task network. Task containers
join only the task network, have no published ports, run as UID 1000 with a
read-only root filesystem, dropped capabilities, process/CPU/memory limits and
a container timeout. Outbound access is needed for GitHub, packages and the
configured provider. The coding overlay requires a **Podman** engine even when
using `docker compose` for configuration validation. The ordinary app still
supports Docker Compose when coding tasks are disabled.

Only the app and worker get `CODEX_RUNNER_URL` and `CODEX_RUNNER_TOKEN`. Only the supervisor
gets the optional provider environment fallback and Podman socket. No bot, database
or GitHub App private key is mounted into coding containers. The supervisor HTTP port is not published.

## Configure repositories

1. Connect the GitHub App and repository as described in [GitHub setup](github-app.md).
2. For local publication, grant the App **Contents: read and write**, **Issues:
   read and write**, and **Pull requests: read and write**, then approve the
   installation's permission update. No Actions permission is needed.
3. Under **Plugins → Codex → Repositories**, add the repository's base branch,
   maintainers, optional setup command and required check command. For this repo,
   use `bun install --frozen-lockfile` and
   `bun run check && bun run typecheck && bun test && bun run build`.
4. Open **Configuration → Edit** to save the workspace provider key or complete
   device-code sign-in, then enable Codex. Older GitHub Actions configurations require local check commands
   for every repository before enabling coding tasks.

Commands are trusted operator configuration, limited to 2,000 characters each;
the model cannot choose them. They execute inside the task checkout. Saving
commands or provider credentials changes the configuration revision and invalidates
pending approvals. Coding tasks do not require a repository Actions workflow.

## Lifecycle and recovery

Each approved task gets a tenant-scoped name, private work volume, checkout and
Codex thread. The supervisor permits one active task at a time; additional
approved tasks wait. An initial preparation container receives only a
repository-scoped read token and pins the base commit. A separate implementation
containers run setup, Codex and the configured checks separately without any GitHub token.
The workspace survives container exit in the task volume. Custom provider Codex
sessions survive there too; device-code auth and sessions in the temporary auth
volume are removed after implementation.

After checks pass, a credential-free export container reads a size-limited patch.
An interrupted export can be recreated because it only reads the work volume and
has no network or credentials. The runner reports timeout failures with their
reason even when its periodic cleanup detects them first.
The worker rechecks actor, repository, configuration and deployment permissions
after minting a fresh repository-scoped publication token. A new container with a
fresh volume applies the patch, rejects `.github/` changes, commits, pushes a unique
task branch and creates a draft PR. It never runs repository scripts. There is no
automatic merge. Publication has its own durable reservation and is never blindly
retried after an uncertain response.

Custom provider spend is separate from Pi chat budgets. Device-code runs use
the connected ChatGPT account's Codex entitlements. Defaults are one active task,
2 CPUs, 4 GiB RAM, 256 processes and 45 minutes including publication; tune the
documented `CODEX_RUNNER_*` environment variables in `.env.example`. Patches are
limited to 5 MiB. Retained workspaces and sessions are removed after 24 hours
(configurable 1–168 hours); stopped containers and volumes are also removed.
Small task tombstones prevent replay of delayed duplicate submissions. Podman
volumes consume host disk, so provision storage for the configured retention.

Stop and access revocation cancel local execution without requiring GitHub
credentials. A stop during publication reports an unknown outcome because a push
or PR may already exist. Workspace deletion does not undo remote writes; abandoned
local work times out and is cleaned by the supervisor. The worker also disconnects
and removes that workspace's sealed device credential after deletion; if the
supervisor is temporarily unavailable, it retries on the next maintenance pass.
Keep the supervisor running
for reconciliation and cleanup. A restart observes existing containers by their
deterministic names, without launching duplicate work.

For an **unknown** outcome, inspect the matching task branch, issue and PR before
starting another request. A container reserved but never started expires at the
task deadline. Encrypted active-task credentials, temporary task tokens and reviewed
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
local fake Responses provider: structured questions, continuation, missing-session
reconstruction, per-turn token accounting and cancellation. It creates a clean
Codex home and uses no host auth or paid model calls. The fixture passed both on
the host and bundled inside the read-only job image with no external network.
The real Podman smoke also covers question checkpoints, automatic repair/repair
exhaustion, fresh and same-PR publication with fake GitHub, remote-head fencing,
device continuation and explicit private-state erasure. Waiting releases the global
runner slot. Retained work checkpoints can seed a new isolated cycle; expired
checkpoints reconstruct from authorized context. See [continuous setup](codex-coding.md).
Local checks do not establish live model intent quality or live publication; the
staging journey remains a release gate.

For a repeatable smoke test without model calls or GitHub writes, build the
`codex-job` and `codex-supervisor` targets with the `:verify` tags, then run
`bun scripts/codex-smoke.ts`. It substitutes a local Git fixture and fake Codex
executable while exercising the real supervisor, Podman socket, resource limits,
volumes, patch export and cancellation, and removes its test resources afterward.
`CODEX_SMOKE_JOB_IMAGE` and `CODEX_SMOKE_SUPERVISOR_IMAGE` can select other tags.
`CODEX_SMOKE_PODMAN_SOCKET` can select an already running rootless Unix socket.
When a host HTTP proxy is configured, exempt localhost with `NO_PROXY`/`no_proxy`
for tests; a loopback-only build proxy may need `podman build --network=host`.

Official references: [Codex device login](https://learn.chatgpt.com/docs/auth#login-on-headless-devices),
[automation auth guidance](https://learn.chatgpt.com/docs/non-interactive-mode#authenticate-in-automation),
[Codex custom providers](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers),
[non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode),
[Podman run](https://docs.podman.io/en/latest/markdown/podman-run.1.html).
