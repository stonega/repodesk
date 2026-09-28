# Local Codex execution with Podman

The optional **Local Podman** backend runs approved coding tasks on the deployment
host. GitHub Actions remains the default for existing configurations. Pi still
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
below. Do not copy `auth.json`, the entire host Codex home, host plugins, or
host credentials into images or task volumes. No key was copied from the device.

The workspace operator can set, replace or remove the provider API key under
**Plugins → Codex implementation → Local Podman → Provider API key**. The app
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

Validate and start when ready to deploy:

```sh
docker compose -f compose.yaml -f deploy/codex/compose.yaml config --quiet
podman compose -f compose.yaml -f deploy/codex/compose.yaml up --build -d
```

The supervisor joins the app network and a separate task network. Task containers
join only the task network, have no published ports, run as UID 1000 with a
read-only root filesystem, dropped capabilities, process/CPU/memory limits and
a container timeout. Outbound access is needed for GitHub, packages and the
configured provider. The optional overlay requires a **Podman** engine even when
using `docker compose` for configuration validation. The ordinary app still
supports Docker Compose without this local backend.

Only the worker gets `CODEX_RUNNER_URL` and `CODEX_RUNNER_TOKEN`. Only the supervisor
gets the optional provider environment fallback and Podman socket. No bot, database
or GitHub App private key is mounted into coding containers. The supervisor HTTP port is not published.

## Configure repositories

1. Connect the GitHub App and repository as described in [GitHub setup](github-app.md).
2. For local publication, grant the App **Contents: read and write**, **Issues:
   read and write**, and **Pull requests: read and write**, then approve the
   installation's permission update. Actions permissions are only needed when
   also using the GitHub Actions backend.
3. Under **Plugins → Codex implementation**, add the repository's base branch,
   maintainers, optional setup command and required check command. For this repo,
   use `bun install --frozen-lockfile` and
   `bun run check && bun run typecheck && bun test && bun run build`.
4. Select **Local Podman**, use **Set API key** to save the workspace provider key,
   and enable the extension. When switching an already
   enabled configuration, save local check commands for every repository first.

Commands are trusted operator configuration, limited to 2,000 characters each;
the model cannot choose them. They execute inside the task checkout. Saving
backend/command settings or provider credentials changes the configuration revision and invalidates
pending approvals. Local tasks do not require a repository Actions workflow.

## Lifecycle and recovery

Each approved task gets a tenant-scoped name, private work volume, checkout and
Codex thread. The supervisor permits one active task at a time; additional
approved tasks wait. An initial preparation container receives only a
repository-scoped read token and pins the base commit. A separate implementation
container runs setup, Codex and the configured checks without any GitHub token.
The workspace and Codex session files survive container exit in the task volume.

After checks pass, a credential-free export container reads a size-limited patch.
The worker rechecks actor, repository, configuration and deployment permissions
after minting a fresh repository-scoped publication token. A new container with a
fresh volume applies the patch, rejects `.github/` changes, commits, pushes a unique
task branch and creates a draft PR. It never runs repository scripts. There is no
automatic merge. Publication has its own durable reservation and is never blindly
retried after an uncertain response.

Provider spend is separate from Pi chat budgets. Defaults are one active task,
2 CPUs, 4 GiB RAM, 256 processes and 45 minutes including publication; tune the
documented `CODEX_RUNNER_*` environment variables in `.env.example`. Patches are
limited to 5 MiB. Retained workspaces and sessions are removed after 24 hours
(configurable 1–168 hours); stopped containers and volumes are also removed.
Small task tombstones prevent replay of delayed duplicate submissions. Podman
volumes consume host disk, so provision storage for the configured retention.

Stop and access revocation cancel local execution without requiring GitHub
credentials. A stop during publication reports an unknown outcome because a push
or PR may already exist. Workspace deletion does not undo remote writes; abandoned
local work times out and is cleaned by the supervisor. Keep the supervisor running
for reconciliation and cleanup. A restart observes existing containers by their
deterministic names, without launching duplicate work.

For an **unknown** outcome, inspect the matching task branch, issue and PR before
starting another request. A container reserved but never started expires at the
task deadline. Encrypted active-task credentials, temporary task tokens and reviewed
task content are private supervisor state. Replacing the
supervisor state volume loses recovery information and must not be used to retry
tasks automatically.

The current Telegram workflow remains one approved issue-to-PR task. Session
files and thread IDs are retained for recovery/inspection; a conversational
continue/resume tool for a completed coding task is not exposed yet. Local checks
and container smoke tests do not prove live provider/GitHub publication; that
remains a staging gate.

For a repeatable smoke test without model calls or GitHub writes, build the
`codex-job` and `codex-supervisor` targets with the `:verify` tags, then run
`bun scripts/codex-smoke.ts`. It substitutes a local Git fixture and fake Codex
executable while exercising the real supervisor, Podman socket, resource limits,
volumes, patch export and cancellation, and removes its test resources afterward.
`CODEX_SMOKE_JOB_IMAGE` and `CODEX_SMOKE_SUPERVISOR_IMAGE` can select other tags.
When a host HTTP proxy is configured, exempt localhost with `NO_PROXY`/`no_proxy`
for tests; a loopback-only build proxy may need `podman build --network=host`.

Official references: [Codex custom providers](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers),
[non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode),
[Podman run](https://docs.podman.io/en/latest/markdown/podman-run.1.html).
