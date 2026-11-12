# Local Code Truth extension

Status: implemented locally. **Workspace → Plugins → Code Truth** is a predefined
Pi extension. It includes eight read-only MCP tools and the companion query skill.
Repository URLs and optional descriptions are editable independently per workspace;
internal IDs are generated automatically and indexing follows the default GitHub
branch. No extension file registration is required.

Repository dialogs persist changes through **Confirm** and close after the request
succeeds. Failed saves keep the entered URL and description open for correction
or retry; Cancel discards them. Pending saves lock fields and dismissal. Removing
a repository saves immediately, retaining its saved card if the request fails.
The title's Enable switch saves independently; no page-level save is required.

## Standard Docker deployment

The base `compose.yaml` includes Code Truth. `docker compose up --build -d`
builds and starts it, and configures the API and worker with its internal URL.
A network-isolated, one-shot `code-truth-token` container runs the app image as
root only to publish a random service token in the private `code_truth_auth`
volume. It atomically preserves an existing token and fails on invalid saved
credentials; the long-running Node/Bun containers mount this volume read-only.
The initializer receives no database, model, GitHub or encryption credentials.

The service has no published host port. Indexes remain in `code_truth_data`,
including across upgrades from the former optional overlay. An idle service
does not fetch repositories; a source-tool call or an explicit index check
configures/indexes the authorized repositories. Disabling a workspace plugin
does not stop the shared service or delete another workspace's snapshots.

Standard release updates build and smoke-test the service image alongside the
app and Codex images, pin its ID in `release.env`, start it before the writers,
and verify authenticated `/health/ready` requests from both app and worker before
promoting the release. Existing host updaters must first be replaced with the
current checked-in updater; an incomplete old bundle fails before cutover.
See [updater installation](updates.md) and [release deployment](vps-deployment.md).

## Custom and legacy service setup

The following host-file token setup is optional. Preserve it for deployments
already using `examples/code-truth.compose.yaml`; the overlay overrides the new
automatic token mounts without replacing the saved host token. Direct Node
deployments still need an explicitly configured service URL/token.

From this repository root, install application and service dependencies for checks:

```sh
bun install --frozen-lockfile
bun install --cwd services/code-truth --frozen-lockfile
```

Create a separate service token once (do not overwrite an existing token):

```sh
mkdir -p secrets
(umask 077; set -C; openssl rand -hex 32 > secrets/code-truth-token)
```

Keep the existing deployment's `POSTGRES_PASSWORD` and `ENCRYPTION_KEY_FILE` settings.
For private repositories, prefer [workspace GitHub App connections](github-app.md)
through **Plugins → GitHub**. For legacy deployments, provide `CODE_TRUTH_GITHUB_TOKEN` through the deployment
environment, with read-only Contents access to the intended GitHub repositories.
It is used only by the local Code Truth service and is never sent to the model or UI.
Public repositories can work without it, subject to GitHub's unauthenticated limits.

```sh
docker compose -f compose.yaml -f examples/code-truth.compose.yaml config --quiet
docker compose -f compose.yaml -f examples/code-truth.compose.yaml up --build -d
```

To retain this host-file token override in subsequent plain `docker compose` commands, set
`COMPOSE_FILE=compose.yaml:examples/code-truth.compose.yaml` in the local `.env`.
Preserve the existing database password, encryption key, transport and origin.
Keep token files readable by the service user and their parent directory private.

This runs Code Truth privately on the Compose network, with no published host port.
Its `/data` volume holds immutable snapshots. Both API and worker receive its private
URL and bearer secret. Standard file-based Pi plugins can coexist by also including
`-f examples/extensions.compose.yaml` in every Compose command.

For processes outside Docker, set the same `CODE_TRUTH_TOKEN_FILE` and
`CODE_TRUTH_URL=http://127.0.0.1:3010` on the bot API/worker. Start the service from its
own directory with `CODE_TRUTH_TOKEN_FILE` set to an absolute token-file path:

```sh
cd services/code-truth
bun run start
```

Set `GITHUB_TOKEN` on that service process for private repositories, and keep
`NO_PROXY=localhost,127.0.0.1,code-truth` if your environment uses an HTTP proxy.
Restart API/worker after changing service credentials or URL. Panel repository
changes apply without a process restart.

## Configure repositories

1. Open **Workspace → Plugins → Code Truth**, then **Add repository**.
2. Enter a canonical HTTPS GitHub repository URL, for example
   `https://github.com/your-org/my-repository.git`. RepoDesk generates the internal
   ID and shows the GitHub repository name; no ID input is needed.
3. Optionally describe the repository's purpose and when to use it (up to 2,000
   characters). The description is available to the assistant as repository
   context, never as instructions or authorization. Indexing automatically follows
   GitHub's current default branch, including after a default-branch change.
4. Confirm the selected workspace in the sidebar. All eligible actors in this
   workspace receive access; other workspaces have independent repositories.
5. Enable Code Truth and save. Standard deployment already provides the service;
   toggling the plugin changes workspace access, rather than deploying containers.
   Saving configuration does not contact GitHub or execute repository code.
6. Expand **Repository indexing status** and choose **Sync &
   check indexes**. Check again after indexing finishes. Each ready repository shows
   its branch, immutable commit SHA and indexing timestamp.

The service initializes a workspace's index on its first source-tool call or
explicit index check.
Until a target is ready, code tools report that it is unavailable. Index refreshes
are deduplicated and triggered on use at most every five minutes. A failed refresh
retains the last usable snapshot; inspect its commit/timestamp. After a restart,
the next source call or explicit check reconfigures the service and reuses matching
snapshots on disk.

Tool registration uses the bundled catalog and performs no upstream calls or
credential lookup. A greeting therefore does not wait for GitHub or MCP, including
when the service is unconfigured, permissions are stale or the upstream returns an
unexpected error. When the assistant actually requests source, the tool resolves
current actor access and credentials, configures its scoped service namespace and
validates the advertised tool names and input schemas before executing. Denial,
connection failure or a catalog mismatch returns a fixed safe code; no unauthorized
source is retrieved. The next tool call retries using current state, without needing
to rebuild the chat host.

Failures emit `code_truth_tool_failed` with a fixed code and tenant/run IDs in
Runtime logs. Raw exception text, source content and credentials are excluded.
The assistant must disclose missing source access and continue unrelated work.

The bundled definitions are generated from the real MCP server, without reading
repositories or contacting an upstream API:

```sh
bun install --cwd services/code-truth --frozen-lockfile
bun run --cwd services/code-truth catalog:update
```

Commit `services/code-truth/src/tool-catalog.ts` with protocol changes. The service
unit tests and offline image smoke reject a stale catalog. The application image's
Node runtime contract also runs the combined production-factory startup fixture
with failed optional integrations before release cutover.

Supported repositories match the upstream service: HTTPS `github.com` only, no SSH,
GitLab, arbitrary local directories, credentials in URLs, or runtime package installs.
Up to 12 distinct repositories can be configured per workspace.
Code is parsed and queried; repository build scripts are not executed.

Legacy saved IDs remain stable. Legacy network mappings are accepted when reading
or saving old settings, but are omitted from the settings response and no longer
select branches. Saving the settings removes those legacy mappings. The internal
MCP adapter uses one `default` snapshot selector with `HEAD`; the service resolves
the actual default branch before indexing and retains its name and commit as
provenance. Deploy matching app/worker and Code Truth service builds for this path.

## Authorization, durability and operations

Only deployment operators can edit settings or initiate indexing, using the normal
session, Origin and CSRF protections. Operators can configure only their own active workspaces.
Repository settings share their workspace’s versioned plugin registry: stale writes are rejected,
changes are audited, and registered file plugins are preserved. Reload the relevant
editor if another save changed the shared revision.

Each worker builds a named Pi extension factory with workspace targets in a closure.
The extension's tool names are reserved against overlapping file-plugin grants. The
same guard, cancellation and durable tool ledger used by file plugins apply here.
A repository change alters the pinned extension digest; any plugin revision
change stops that workspace’s active runs before their next guarded step. Completed
code-query results are replayed from the durable ledger; uncertain calls are not
repeated automatically. An already running index/query may finish locally after a
revocation, but its result cannot pass the worker's next guard for delivery.

The local service accepts configuration only from the bot's secret-bearing client.
Its namespace hashes the workspace UUID and exact repository configuration, preventing
cross-workspace target mixing. Model tool parameters accept only configured target
and network IDs. Source results preserve commit/branch/file/line evidence, use bounded
output, and count against run budgets. The companion skill instructs the model to
treat code and manifests as evidence, not commands or authorization.

Code answers cite the returned target, network, branch and commit in plain text,
with file/line references such as `package.json:1–111`. The `[source:EXACT_ID]`
notation is reserved for authorized chat-message IDs, including history retrieved
through `query_chat_history`; repository paths are never valid IDs in that notation.
The base prompt and companion skill both state this distinction. Chat-source
validation remains strict. Code provenance is a model instruction, not a separate
mechanical guarantee that each claim follows from the referenced code.

Run only one Code Truth process per data volume. Up to 128 active configuration
managers are kept in memory; unused managers expire on later configuration requests
after an hour. Each configuration retains active/leased snapshots and two recent
commits per target. Old configuration directories remain on disk after editing,
disabling, or removing grants, including workspace deletion. These local source
copies are separate from PostgreSQL retention: pause/stop Code Truth and remove the
corresponding retired namespace directories under its data volume when erasure is
required. Do not remove snapshots from a running service. Back up its volume
separately if needed; indexes can be rebuilt from GitHub while commits remain available.

The service must remain private: its bearer token authorizes management and all
namespaces. This local mode replaces upstream OAuth with the bot's tenant authorization;
it is not a public multi-user MCP login endpoint. Raw service credentials and GitHub
tokens never appear in admin responses, model arguments, or routine logs.

See [API example](../../examples/code-truth.http), [upstream provenance](../../services/code-truth/UPSTREAM.md),
and [extension compatibility](../design/llm-extensions.md).
