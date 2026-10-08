# LLM extensions (plugins)

Status: implemented headless subset, Pi 0.85.1. **Plugin and Pi extension mean the
same thing.** An extension is executable JavaScript/TypeScript with a default
`(pi: ExtensionAPI) => void | Promise<void>` factory. It can add model tools and
supported lifecycle hooks. Instruction skills remain Markdown managed in the panel.

## Compatibility

The worker uses Pi's `DefaultResourceLoader`, with all automatic discovery disabled,
explicit local file paths and isolated temporary working directories. Existing Pi
extension files using the following APIs load unchanged. Pi's loader handles TypeScript,
`@mariozechner/*` aliases and `@sinclair/typebox` compatibility imports. We pin
`@earendil-works/pi-coding-agent` alongside `pi-agent-core` and `pi-ai` at 0.85.1;
the added dependency supplies the real loader, API types and extension helper exports.
It also brings Pi's transitive CLI/TUI dependencies, but no coding tools are enabled.

| API | Headless behavior |
| --- | --- |
| `pi.registerTool` | Registers explicitly granted tools; TypeBox validation and sequential execution. Rendering callbacks are unused. Register during factory initialization only. |
| `pi.on("before_agent_start")` | Receives prompt/system prompt; system prompt replacements chain in registration order. Custom-message injection is unsupported. |
| `pi.on("context")` | Receives a copy of model messages before every provider dispatch; message replacements chain and count against the normal input budget. Only standard user/assistant/tool-result messages are accepted. |
| `pi.on("tool_call")` | Can veto a validated tool call with `block`, `reason`, `terminate`. Input mutation is rejected. Application guards run first and again afterward. |
| `pi.on("tool_result")` | Observation only. Replacing or mutating durable tool results is rejected. |
| `session_start`, `agent_start`, `agent_end`, `session_shutdown` | Awaited lifecycle notifications for each run invocation, including continuations. `agent_end` receives messages with thinking removed. Shutdown cleans up on success or failure. |
| `pi.getActiveTools`, `pi.getAllTools`, `pi.getThinkingLevel` | Read the bound run configuration after loading. |
| `pi.registerFlag`, `pi.getFlag`, `pi.events` | Pi's in-memory flag defaults/event bus; no CLI flag overrides. Subscriptions are invalidated at shutdown. |
| Context | `hasUI: false`, `mode: "print"`, temporary `cwd`, model/thinking metadata, cancellation signal, current system prompt. |

Terminal dialogs, commands/shortcuts, session manipulation, provider registration,
model switching, persistent custom entries, message injection, dynamic tool registration,
and unsupported event names fail explicitly. There is no blanket claim that every
Pi community extension works. Hook failures stop the run with a fixed error code;
raw extension exception messages are excluded from application logs and model results.

Application-owned built-ins may explicitly allowlist stable tool fault codes for
model-visible policy feedback. The host reconstructs the fault from its code;
exception messages remain private. File extensions and unlisted built-in faults
continue to return `extension_tool_failed`.

## Installation and grants

The Plugins landing page shows compact Installed cards for built-in Code Truth,
built-in Codex, built-in Review Bot and workspace-registered file extensions. Clicking a card opens
its detail route, where the existing configuration and controls live. The
Markets section links to a small, dated selection of popular packages from
[Pi's package catalog](https://pi.dev/packages?type=extension). These are
external discovery entries, not installed plugins or compatibility endorsements.
Market detail pages link to the upstream package. RepoDesk still requires
operator review and a local entry file registered through the panel.

The application registry also includes the built-in `query_model_cost` tool.
It uses the current run's published skill grant and retained workspace accounting;
no file plugin or external billing API is involved. It defaults to the actor's own
costs this UTC month, with today/retained-history filters and per-model totals.
Queries require private chat; workspace-wide totals and monthly budget require
current owner/admin access. Authorization is rechecked before replaying a stored
result. New starter skills grant it; existing skills require an explicit edit and
publication. See [examples and accounting limits](../../examples/model-cost.md).

The deployment operator reviews and installs local extension files and dependencies.
Open **Workspace → Plugins** (`/admin/plugins`) to register a file, edit its version,
tool names for the selected workspace, enable/disable it, or remove its registration.
Removing a registration leaves the installed file untouched. New entries default to
disabled. Switching workspaces loads that workspace’s independent configuration.

The panel requires an absolute file path shared by the API and worker. It verifies
readability and pins file contents when enabling or changing a plugin version; it
never executes plugin code to render or save configuration. “File verified” is not a
runtime compatibility result. Changed/unavailable files are shown explicitly; after
reviewing changed code, update its version and save. Unrelated setting edits preserve
existing content hashes. Runtime errors remain visible in Runs and Runtime logs.

Settings are stored on each workspace in PostgreSQL with independent optimistic
revision checks and atomic workspace audit entries. Operators can configure only
their own active workspaces. Workspace administrators cannot read or change executable plugin settings.
The API requires an authenticated operator, CSRF token and exact request origin.

No runtime npm/git installation, automatic discovery in `~/.pi`, web upload or Telegram
installation command is provided. An existing `PI_EXTENSIONS_FILE` manifest remains
an optional fallback for each workspace until its first panel save:

```json
[
  {
    "id": "word-count",
    "version": "1",
    "path": "./pi-extension.ts",
    "workspaces": ["00000000-0000-4000-8000-000000000001"],
    "tools": ["count_words"],
    "execution": "read-only"
  }
]
```

Replace the example workspace UUID with the actual workspace. Paths are absolute or
explicit `./`/`../` file paths relative to the manifest. Only `.ts`, `.js`, `.mjs`
entry files are accepted; preinstall external dependencies next to the extension.
`enabled` is optional in manifests and defaults to `true`; panel entries default to
disabled. `tools` lists every tool the factory registers. Tool names cannot replace application
tools or collide with another extension. Workspace grants also scope hooks: ungranted
extensions are never imported for that workspace. All eligible actors in a granted
workspace receive these tools; these grants are separate from skill-declared tools.
An empty saved panel registry overrides the manifest and enables none for that
workspace. With no panel settings and no manifest, plugins remain off.

Run a factory afresh for every invocation; keep tenant-specific state inside it.
Do not keep tenant data in module globals, which Node or extension dependencies may
cache. These are trusted **in-process** modules with the worker's OS permissions,
not sandboxed code. The read-only declaration records the operator's review; it cannot
technically prevent arbitrary Node code from writing or making network requests.
Only install reviewed read-only/pure file tools and hooks. External writes must use
an application service with actor, scope, destination, approval and recovery checks.
The built-in GitHub proposal tool records a local approval draft; its application
service performs issue submission only after explicit human approval. File plugins
remain read-only.
Do not use `pi.exec`, direct messaging, ambient credentials, or filesystem side effects.
Do not log private context from an extension.

## Durability and policy

Run records pin the enabled, workspace-scoped catalog digest at first execution.
Workers read panel settings before claiming each run. A changed catalog prevents
continuation of an older run; changes to that workspace’s panel revision also stop
its in-flight work at the next guard, including before tools, model calls and delivery.
An already executing external operation cannot be recalled. Other workspaces’ plugin
revisions are independent, including workspaces owned by the same operator.

Panel registration, editing, enable/disable and removal changes require no restart.
Entry-file hashes are checked before loading. Updating code requires review and a
new saved plugin version. Bump versions and restart workers when upgrading imported
dependencies, whose contents are not recursively hashed and may be cached by Node.
Legacy manifest edits still require restarting API and worker processes; panel settings
take precedence once saved. Pause the deployment first when revoking legacy settings.

Factories run only after the run's access guard. The existing revocation, approval,
cancellation, turn/tool limits and budgets apply to extension model/tool work. No
model-visible parameter grants workspace authority. The worker reserves a tool-call
record under the tenant run before execution, then stores its bounded result. A repeated
completed call ID reuses that result; a started call with an unknown outcome is never
replayed automatically. A crash before the normal transcript checkpoint can reconstruct
a committed result through the existing recovery path. Imported tools that contact
other services must honor the cancellation signal and their own tenant/data boundaries.

Read [Pi extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
and [SDK loading documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
for upstream behavior. The table above defines this application's supported subset.

## Predefined Code Truth

The Plugins page includes a built-in Code Truth extension backed by a private local MCP service. Operators configure GitHub repositories, network/branch mappings and repositories for the selected workspace. Its named Pi factory registers eight read-only MCP tools and loads the companion skill. The shared registry revision, run digest, guards and durable tool ledger apply. See [local service setup and boundaries](../implementation/code-truth.md) and [source provenance](../../services/code-truth/UPSTREAM.md).

## Workspace API and migration

Use `/api/admin/workspaces/:id/plugins` for GET/PUT and
`/api/admin/workspaces/:id/plugins/code-truth` for GET/PUT. Index status uses POST
`/api/admin/workspaces/:id/plugins/code-truth/status` with `{}`. The URL selects the
workspace; plugin/repository `workspaces` arrays must contain exactly that ID.
The panel fills this field automatically. The former operator-wide endpoints are
removed. File plugins and Code Truth share a revision only within their workspace.

Migration `006_workspace_plugins.sql` copies each operator registry into its existing
active workspaces, retaining only entries and repositories granted to that workspace.
It preserves disabled entries, pinned hashes, versions and revisions. Workspaces with
an existing empty registry keep an explicit empty configuration, so the fallback
manifest is not reactivated. Ungranted registrations are not copied. Existing
workspace configurations are preserved and the old deployment registry is removed.
Historical operator audit records remain available; new edits appear in workspace
Audit. Workspace deletion purges its plugin settings along with other content.
Run migrations before restarting the API and worker with this version.

## Predefined GitHub issue drafts

A connected GitHub installation exposes `propose_github_issue` through a built-in Pi
factory, independently of Code Truth. The connection/repository list is pinned in the
catalog digest and checked again when proposing, approving and submitting. The model
can draft a repository ID, title and body, but cannot approve or invoke the external
write. Telegram's actor-bound approval controls publish the exact reviewed payload.
The worker reserves the send durably and never replays an ambiguous POST. See
[permissions, limits and recovery](../implementation/github-app.md#submit-an-issue-from-telegram).

## Predefined Codex implementation

The optional Codex extension exposes `propose_coding_task`, `coding_task_status`
and `cancel_coding_task`. Repository-specific Telegram maintainer grants and a
complete approval bind issue creation and local Codex execution.
Application services own issue/publication writes and durable task state. Codex runs
in an isolated local Podman container, followed by
project checks and separate draft PR publication. Local execution and its
custom-provider configuration and workspace API keys are described in [the Podman guide](../implementation/codex-podman.md).
See [configuration, permissions and recovery](../implementation/codex-coding.md).

The [continuous collaboration workflow](codex-collaboration.md) also provides
durable task inputs, questions, scoped direct execution and follow-ups on the same
PR. Pi relays original requirements; Codex owns investigation, technical decisions,
implementation and verification. `start_development_task` is exposed only when a
configured repository explicitly uses Direct policy, and advertises only Direct
targets. Reviewed targets retain `propose_coding_task` and Telegram approval.
`send_development_input`, `development_task_status` and
`cancel_development_task` handle existing continuous tasks. Live pilot validation
remains pending.

## Predefined Review Bot

[Review Bot](../implementation/review-bot.md) receives authenticated GitHub App events,
reviews selected PRs at exact commits and accepts verified maintainer tags for
read-only answers or explicitly authorized same-PR fixes. It reuses the Codex runner
and credentials. Its application services own standing review policy, task grants,
repository permissions, durable publication and GitHub progress comments. It does
not broaden the executable file-extension API or expose an arbitrary GitHub write tool.
