# Code Truth setup failure blocks ordinary chat

Investigated on 2026-10-27 through the existing VPS SSH connection. The running
release was package v0.1.44, bundle `1793000844503-81693002`, with Node 24.21.0
and Pi 0.85.1. No deployment, configuration change, run replay, model call or
Telegram message was performed during this investigation.

## Evidence and limits

Run `cceedf22-1a68-468a-a308-a9aa2564fb70` failed with
`extension_load_failed` at 2026-10-27 01:48:18 UTC. Two following runs failed
with the same code. All three retained zero model attempts. The worker,
application, runner, PostgreSQL and Code Truth services were healthy. The
packaged Node runtime contract passed inside the running worker, and authenticated
Code Truth liveness/readiness requests returned HTTP 200.

A separate diagnostic process loaded the workspace's built-in plugins using the
existing worker dependencies and current saved configuration. All six factories
loaded successfully. The affected member's GitHub snapshot was connected, matched
the workspace connection revision and had refreshed at 01:51:15 UTC. This proves
that setup recovered at probe time, without proving successful Telegram or model
execution.

The original loader discarded the underlying factory fault, so the retained
failure code cannot establish whether those three historical failures came from
GitHub authorization, token retrieval or the MCP connection. The investigation
does not establish that the latest deployment introduced this existing startup
coupling.

## Reproduction and cause

A second probe changed only the member's GitHub snapshot timestamp in its own
in-memory workspace copy. It neither changed PostgreSQL nor relaxed permissions.
Code Truth's actor-scope resolver rejected the stale authorization with
`github_user_access_denied`. Pi reported that error for `<inline:code-truth>`;
RepoDesk then replaced it with `extension_load_failed`, exactly matching the
reported outward failure. The other five factories loaded successfully.

Code Truth resolves current actor access, obtains scoped GitHub credentials and
lists MCP tools while initializing the extension host. An exception prevents
that entire host from opening. Consequently a repository dependency can block
an unrelated greeting before the first model attempt. The packaged runtime check
previously covered file extensions, GitHub and Obsidian, but not unavailable
Code Truth setup.

## Correction

The Code Truth factory handles an explicit list of GitHub authorization,
credential availability, rate-limit and Code Truth connection faults. On those
faults it registers no repository tools or source skill and gives the assistant
a fixed-code notice to disclose missing source access when relevant. Other chat
and plugin tools remain available. A new run retries setup; each source tool call
still rechecks the current scope. Safe allowlisted tool fault codes also remain
visible if access changes after initialization, with raw exception text excluded.

Cancellation cannot become a degraded model turn. Unknown exceptions and MCP
catalog mismatches retain strict loading failure behavior. File-extension loading
and all repository authorization boundaries are unchanged.

The corrected diagnostic bundle passed the same stale-snapshot probe inside the
existing VPS worker: all six factories loaded, unrelated tools remained available,
and all eight Code Truth tools were absent. Diagnostic files were removed. This
was an isolated process, not a replacement of the running worker code.

Validation passed `bun run check`, `bun run typecheck`, `bun test` (1,208 tests
across 132 files with disposable PostgreSQL), `bun run build` and the Node runtime
contract. The rebuilt runtime contract also passed with Node 24.21.0 in a disposable
container from the deployed image, with copied build artifacts and network disabled.
Focused regressions cover unrelated chat, unavailable services, stale/denied scope,
per-run recovery, revocation before tool execution, private-error suppression,
cancellation and incompatible/unknown factory failures. Real local MCP tools and
source retrieval continue to pass the service integration tests.

## Authorized rollout

The fix was committed and pushed as `df4dab5`, then deployed in bundle
`1793066669306-68318929` on 2026-10-27. It replaced the host-updater v0.1.45 build
`1793065829494-2218607`, which completed during fix preparation. The guarded
cutover verified both coding checkpoints and a protected PostgreSQL backup.
All four services are healthy; all 45 deployed artifacts and the public admin
assets match the tested build. Configuration, credentials, persistent mounts,
PostgreSQL and all three CI runner identities were preserved. See the
[deployment record](../docs/implementation/vps-deployment.md#code-truth-startup-isolation-deployment-2026-10-27).
