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

## Preventive follow-up

The initial correction handled known factory errors, but still performed optional
service discovery during startup. One initial GitHub App/configuration lookup also
remained outside that handler. The follow-up removes that failure dependency:
Code Truth registers bundled schemas and resolves access, credentials and remote
compatibility only when a source tool is invoked. Unknown remote failures therefore
cannot affect an unrelated greeting. Current authorization remains required for
all source calls, including retries within the same host.

The generated catalog is compared against the real MCP server in service tests
and the offline image smoke, preventing silent schema drift. A combined fixture
uses the production plugin assembly with every standard agent integration enabled
for owners and ordinary members in 16 configurations. It blocks all external
transports and optional credential lookups and requires a completed greeting.
Unit tests and the packaged Node contract share this fixture; CI and the host
updater already run the contract against the exact app image before cutover.
Source failures now emit a sanitized `code_truth_tool_failed` event with fixed
cause code and tenant/run IDs. The repository reliability rules and release
runbook require future integrations and incident fixes to extend these checks.

Follow-up validation passed lint, application/service types, build, all 1,225 tests
across 135 files, and the packaged Node contract with all 16 startup configurations.
All four images built, and the exact Node 24 app image and Code Truth image passed
their offline contracts. Compose startup, migration rerun, CPU speech imports,
supervisor/task CLI and disposable backup/restore passed. Restoring the old eager
App lookup made the new startup regression fail; changing a bundled catalog title
made the service contract fail. This follow-up is prepared for the next VPS rollout;
the earlier authorized hotfix deployment above remains the live deployment evidence.
