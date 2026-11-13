# Manage GitHub plugins

Repository plugins are an opt-in read-only preview. See [plugin development](plugin-development.md)
for the author contract and [local extensions](local-plugins.md) for trusted Pi files.
Only the deployment operator owning a workspace can install or manage plugin code.
An ordinary workspace member's service connection never authorizes code installation.

## Configure the private runner

Build the application, restricted job and private supervisor from the same reviewed
RepoDesk commit. Use the normal release procedure before a production rollout.
The following commands prepare local images; they do not connect services:

```sh
docker build --target app -t repodesk:plugins .
docker build --target plugin-job -t repodesk-plugin-job:plugins .
docker build --target plugin-supervisor -t repodesk-plugin-supervisor:plugins .
docker image inspect --format '{{.Id}}' repodesk-plugin-job:plugins
```

Set `PLUGIN_RUNNER_IMAGE` to the reported immutable `sha256:...` ID or a repository
image digest already present on the runner's Docker daemon. Tags are rejected and
the supervisor never pulls a missing job image during a call.

The supplied `examples/plugin-packages.compose.yaml` extends the normal Compose
file. Set `APP_IMAGE`, `PLUGIN_SUPERVISOR_IMAGE`, `PLUGIN_RUNNER_IMAGE` and the normal
deployment variables, then validate it:

```sh
docker compose -f compose.yaml -f examples/plugin-packages.compose.yaml config --quiet
```

When deliberately starting that stack, its initializer creates a private shared
runner token and prepares package-storage ownership for the Node app user. Only
the trusted supervisor receives the selected Docker socket. App and worker share
private package storage and a read-only token volume; they receive no Docker socket.
There is no public runner port. Restrict the supervisor to trusted app/worker
network clients: its token authenticates a privileged internal service.

For other deployments configure:

| Component | Settings |
| --- | --- |
| App and worker | Same `PLUGIN_PACKAGES_DIRECTORY`, `PLUGIN_RUNNER_URL`, `PLUGIN_RUNNER_TOKEN_FILE` (or `PLUGIN_RUNNER_TOKEN`), and normal encryption key |
| Supervisor | Same runner token, immutable `PLUGIN_RUNNER_IMAGE`, optional `PORT` (3030), access to the dedicated Docker daemon |
| Package storage | Private, persistent, writable by app user; available to both app and worker; never served by the web server |

The supervisor's Docker access is an operator trust boundary. Use a maintained
Linux host/daemon appropriate to your third-party-code policy. Container isolation
shares that host's kernel. Author containers use no network, read-only roots,
non-root users, dropped capabilities, bounded resources and disposable scratch.
The supervisor must stay available to enforce deadlines and remove jobs; it reaps
expired labelled containers after interruptions. During daemon outages, restore
supervision and verify cleanup before re-enabling plugins.

Optional missing configuration does not block ordinary greetings. Package source
installation needs storage; enabling needs a configured runner. Configured status
means settings exist, not that the remote daemon/image has passed its release tests.

## Install, configure and enable

1. Open the workspace's Plugins page and choose New → GitHub repository.
2. Enter the HTTPS repository root and optionally a `vX.Y.Z` tag or full commit.
   Public repositories work without a source token. Private sources must be among
   this workspace's selected GitHub App repositories with Contents read access.
3. Preview the exact commit. Read its executable bundle, publisher, requested
   capabilities and external destinations before checking the review box.
4. Install. The new installation is disabled and no author code has run.
5. Open its detail page. Edit saved settings and grant only needed capabilities;
   configure required connections, then enable using the title switch.

The platform never runs Git hooks, package scripts, builds or dependency installers
from a downloaded repository. It verifies a bounded GitHub archive and caches the
manifest, executable, package metadata, README, LICENSE and approved linked guides.
Their sorted file hashes produce the installed package digest; the Git commit
pins the remaining repository source. Cache reads verify those hashes again.

Source previews expire after 15 minutes and bind the operator, workspace revision,
intent and immutable source. Saving another configuration, moving a tag or changing
source access requires a fresh preview. Duplicate preview/apply requests are safe
to retry with the same request identity; an expired or mismatched preview is rejected.

## Connections and current permissions

GitHub source visibility grants no conversational repository access. GitHub metadata
reads still require the invoking member's verified, current repository permission.

For HTTP workspace connections, save a scoped read token if needed, explicit
allowed members, and private-only or selected active group destinations. Personal
connections require a verified Telegram identity linked to the panel account and
work only in that member's private conversations. This preview has no standalone
Telegram connection editor. Tokens are write-only in the panel and encrypted at
rest; a blank token field preserves the current token.

Read the approved destinations: a service may receive tool arguments in query
values. The broker uses exact HTTPS origins, paths and query-key allowlists,
public-address DNS pinning, no redirects and bounded JSON responses. The author
container never receives connection credentials.

Changing settings, grants or connections increments the installation generation.
Disable/remove/update or membership/repository revocation prevents further calls,
stored-result reuse and pending delivery under the old run policy. An unavailable
plugin is surfaced as a fixed tool error; unrelated tools and greetings stay usable.

## Update, rollback and remove

Use Check for updates to preview a version, read its source and permission changes,
and apply explicitly. There are no background executable updates. The detail page
reports when the exact version is already installed.

The last five distinct artifacts remain in version history. Review rollback opens
an exact retained commit for a fresh source check; it does not restore old grants,
removed connection bindings or active work. Applying any version leaves it disabled.
A published version cannot silently acquire different installed contents.

Removal drops the active installation and connection bindings and stops dependent
work. Private artifacts remain for recovery/audit until unreferenced collection.
An authenticated operator can request `POST /api/admin/workspaces/<id>/plugin-packages/cleanup`
with the current `{"revision": N}` and normal session/origin/CSRF controls. Collection
retains installed/history artifacts, unexpired previews and all retained run pins;
only unreferenced artifacts/staging directories older than 24 hours are removed.
No automatic age-based deletion of retained run evidence is performed. Include the
private volume in your workspace retention/deletion and backup procedures.

## Diagnose failures

- Invalid source: check root URL, version agreement, committed bundle, README,
  LICENSE, supported manifest and current private-source grant. Specify an exact
  ref when the bounded default tag scan cannot select one.
- Version conflict/expired preview: reload saved settings and preview again.
- Unavailable runner: check private network/token, the exact local job image and
  supervisor logs. Fixed diagnostic codes omit author exception text and secrets.
- Permission or connection denial: check the current invoking member, repository,
  granted capability, connection binding and conversation destination.
- Timeout or cancellation: confirm labelled job containers disappear. Restore
  supervisor/daemon access and its expiry sweep after interruption; do not retry
  an uncertain saved call automatically.
- Corrupt/missing artifact: keep the installation disabled and obtain a newly
  reviewed valid source. Do not edit cache bytes to bypass verification.

Back up PostgreSQL state and the private package volume consistently,
with the encryption key protected separately. A restore must retain immutable
artifact identities and use current reviewed connection grants before enablement.
