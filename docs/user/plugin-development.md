# Plugin development

Build a custom tool as a Pi extension file, keep its source in a GitHub repository,
and give a reviewed version to a RepoDesk deployment operator for installation.
One repository can contain one plugin with several tools and optional instruction
skills. This guide walks through a small word-count plugin.

RepoDesk currently registers **local files**. The panel does not clone GitHub
repositories, install npm packages or run build scripts. There is no published
RepoDesk plugin SDK or supported `repodesk.plugin.json` installation format.
GitHub hosts your source and releases; the operator installs the reviewed file.

File plugins run inside the worker process with its operating-system permissions.
Install trusted, reviewed code only. The `read-only` registration records that
review; it does not enforce filesystem or network isolation. Use file plugins for
pure computation or reviewed read-only operations. External writes belong in
application services that enforce actor, scope, destination, approval and recovery.

## Before you start

You need Bun for authoring and a test RepoDesk deployment whose operator can mount
files and manage **Workspace → Plugins**. Workspace administrators and ordinary
members cannot register executable plugins.

The example uses Bun **1.3.14**, Pi **1.5.2** and TypeBox **1.3.7**. Match the Pi
types to the version used by your target deployment. Upstream Pi supports features
outside RepoDesk's headless subset; use the compatibility section below when
choosing APIs. Bun builds and tests the plugin; Node runs it in RepoDesk.

For reusable instructions without executable code, use a [skill](skills.md).
Skills can request existing tools but cannot install or authorize a new tool.

## 1. Create the repository

Use a small layout:

```text
repodesk-word-count/
├── src/index.ts
├── tests/word-count.test.ts
├── package.json
├── bun.lock
├── tsconfig.json
├── biome.json
├── dist/plugin.mjs
├── README.md
├── CHANGELOG.md
└── LICENSE
```

Create `package.json`:

```json
{
  "name": "repodesk-word-count",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "bun@1.3.14",
  "scripts": {
    "check": "biome check src tests",
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "build": "bun build ./src/index.ts --target node --format esm --outfile ./dist/plugin.mjs"
  },
  "dependencies": {
    "typebox": "1.3.7"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.14",
    "@earendil-works/pi-coding-agent": "1.5.2",
    "@types/bun": "1.4.2",
    "typescript": "5.9.3"
  }
}
```

The Pi import below is type-only; the bundle does not include another Pi runtime.
TypeBox is a runtime dependency bundled into the output. Keep runtime dependencies
explicit and inspect the generated file before sharing it. Avoid native addons,
dynamic imports or external files in this first plugin so the single bundle is
the complete runtime artifact.

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["bun"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

Create `biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.14/schema.json",
  "formatter": { "indentStyle": "space" }
}
```

Run `bun install` once and commit the generated `bun.lock`. Subsequent clean
checkouts and CI should use `bun install --frozen-lockfile`. Keep credentials,
private inputs, `node_modules/` and local deployment settings out of Git.

## 2. Implement the tool

Create `src/index.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "count_words",
    label: "Count words",
    description:
      "Count whitespace-separated words in supplied text. No external I/O.",
    parameters: Type.Object(
      { text: Type.String({ maxLength: 12000 }) },
      { additionalProperties: false },
    ),
    async execute(_callId, params, signal) {
      signal?.throwIfAborted();
      const count = countWords(params.text);
      return {
        content: [{ type: "text", text: String(count) }],
        details: { count },
      };
    },
  });
}
```

The default export is a factory receiving Pi's `ExtensionAPI`. Register tools
synchronously during factory initialization, with stable unique names, a useful
description and bounded parameter schemas. The operator must declare every
registered name when installing the plugin.

`execute(callId, params, signal, onUpdate, context)` receives validated arguments
and returns `content` and `details`. `content` is the model-facing result; keep both
fields small and free of credentials or unrelated private data. Honor cancellation
and bound any read-only I/O. TypeBox schemas are validated through Pi Schema;
TypeBox-only refinements, codecs and custom registered formats are not evaluated.
Enforce any additional semantic checks in the tool itself.

This example counts whitespace-separated tokens. It does not perform linguistic
word segmentation for languages without spaces.

## 3. Test and build

Create `tests/word-count.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { countWords } from "../src/index.ts";

test("counts words separated by spaces", () => {
  expect(countWords("one two three")).toBe(3);
});

test("handles repeated whitespace", () => {
  expect(countWords("  one\n\ttwo  ")).toBe(2);
});

test("handles empty input", () => {
  expect(countWords("")).toBe(0);
  expect(countWords(" \n\t ")).toBe(0);
});
```

Run these commands in the plugin repository:

```sh
bun run check
bun run typecheck
bun test
bun run build
node --check dist/plugin.mjs
```

The build targets Node and bundles dependencies into `dist/plugin.mjs`. Keep the
output readable for operator review. Do not use Bun-only runtime APIs in handlers.
These unit tests check counting behavior; installation and a test bot run still
need verification against the target RepoDesk version.

Commit the source and lockfile, tag the reviewed version and provide the generated
bundle through the repository or a GitHub release. In the README record:

- Purpose, exact registered tool names and input/output limits.
- Compatible RepoDesk/Pi versions and the required Bun version.
- Build/test commands, runtime dependencies and any data sent to external services.
- Source commit, package version and how the operator can obtain the reviewed bundle.

The package version helps release tracking. RepoDesk uses the version entered in
the plugin registration and does not read it automatically from `package.json`.

## 4. Install in a test workspace

The deployment operator reviews the source, dependency changes and actual bundle,
then copies the bundle into a versioned deployment directory, for example:

```text
extensions/word-count/0.1.0/plugin.mjs
```

For Docker Compose, save the following as `compose.plugins.yaml` beside the base
`compose.yaml`:

```yaml
services:
  app:
    volumes:
      - ./extensions:/app/extensions:ro
  worker:
    volumes:
      - ./extensions:/app/extensions:ro
```

Both services need the same readable file at the same absolute container path.
The container's `node` user must be able to traverse the directories and read the
bundle. A read-only mount protects the package files from modification through
that mount; the plugin still runs with the worker's other permissions.

In the existing deployment directory, preserve the original Compose project name,
environment and all other override files. Add this override to that same command
set. For a deployment using only the base file, the commands are:

```sh
docker compose -f compose.yaml -f compose.plugins.yaml config --quiet
docker compose -f compose.yaml -f compose.plugins.yaml up -d app worker
```

Adding the mount recreates the affected containers. Use a test deployment or the
maintenance process described in [Backup, upgrades and recovery](maintenance.md).
Continue including the plugin override in later deployment commands. The dedicated
VPS panel updater does not preserve arbitrary custom Compose overrides; plan plugin
mounts and upgrades with the deployment operator.

In the panel, select the test workspace and open **Plugins → New**. Register:

| Setting | Example |
| --- | --- |
| ID | `word-count` |
| Version | `0.1.0` |
| File path | `/app/extensions/word-count/0.1.0/plugin.mjs` |
| Tool names | `count_words` |
| Execution | `read-only` |

New panel registrations default to disabled. Save the reviewed registration and
enable it for the selected workspace. File verification establishes readability
and content identity, not runtime compatibility. No restart is needed for panel
registration or enablement once the mount is present.

From an active member's private test conversation, ask:

```text
Use count_words to count the words in: one two three
```

Check the run record for an actual `count_words` call and result `3`; a natural
language answer alone does not prove that the plugin ran. Test cancellation and
disablement before sharing it more widely. Avoid logging private test messages.

## Compatibility and access

RepoDesk supports a headless subset of Pi's extension API:

| API | Supported behavior |
| --- | --- |
| `pi.registerTool` | Static registration during factory initialization; declared tools execute sequentially |
| `before_agent_start` | Can replace the system prompt; custom-message injection is unsupported |
| `context` | Can replace supported conversational messages; application-owned system instructions and tools remain protected |
| `tool_call` | Can veto a validated call; cannot mutate its input |
| `tool_result` | Observation only; cannot replace or mutate results |
| `session_start`, `agent_start`, `agent_end`, `session_shutdown` | Per-invocation lifecycle notifications, including continuations |
| `getActiveTools`, `getAllTools`, `getThinkingLevel` | Read the bound run configuration after loading |
| `registerFlag`, `getFlag`, `pi.events` | In-memory defaults and events; no command-line overrides or durable event queue |

The context has `hasUI: false`, `mode: "print"`, a temporary working directory and
cancellation/model metadata. Terminal UI, commands, shortcuts, session management,
provider/model switching, message injection, dynamic registration and nested tool
execution through `context.tools` or `context.executeTool` are unsupported. Do not
use `pi.exec`, ambient credentials, direct Telegram sends or filesystem side effects.
An upstream Pi extension must be reviewed against these limits before installation.

Keep workspace-specific state inside the factory. RepoDesk creates it for each
invocation, but Node and imported modules can cache module globals. A module global
must never hold tenant data, conversation contents or another member's credentials.
Do not treat model-supplied workspace/user IDs as authorization.

Enabled file-plugin tools are available to eligible actors in their granted
workspace, independently of skill tool declarations. Registration grants are
workspace-wide, not a per-member secret boundary. Do not add private account
credentials to the file or use them for every workspace member. Service/account
access needs current application-managed authorization. The optional
[Browser integration](browser.md) also requires an explicit grant and the current
member's private browser permissions.

Optional network, credential and service checks belong inside an authorized tool
invocation. Importing the file or registering tools must not contact external
services or fail because an optional connection is unavailable.

## Update, disable and remove

To update, build and review a new version, place it at a new versioned path, and
save the new path/version in the panel. Keep the previous artifact until the
operator no longer needs it for diagnosis or a reviewed replacement. Do not
overwrite enabled code and expect RepoDesk to accept changed bytes automatically.

Entry-file hashes are checked before loading. Imported dependencies are not
recursively hashed; bundling keeps this example's executable dependencies in the
reviewed entry file. If you deploy unbundled dependencies, review and version them
explicitly and restart workers after dependency changes to clear module caches.

Plugin configuration changes can stop the affected workspace's in-flight work at
the next guard. Existing runs pin their catalog and do not silently continue with
new code. Disablement blocks subsequent guarded work; it cannot undo an operation
already sent upstream. Removing the registration leaves the installed files intact.

A completed duplicate call can reuse its saved result. A started call whose outcome
is unknown is not automatically replayed. Honor cancellation, do not add hidden
retry loops, and inspect the original run before starting replacement work.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Cannot register or edit a plugin | Use the deployment operator account for its own active workspace |
| File unavailable | Check the absolute container path, mounts on both services and file/directory permissions |
| File changed | Review the new bytes, update the plugin version and save the reviewed registration |
| Tool absent | Check the selected workspace, enablement, declared names and factory registration |
| Tool collision | Choose a name distinct from built-ins and every other enabled plugin |
| Plugin loads in Pi but fails in RepoDesk | Remove unsupported APIs, dynamic registration or top-level service checks |
| Tool execution fails | Inspect the run's fixed diagnostic code and reproduce with synthetic input in tests |
| Old run stops after an update | Review its state; new configuration does not replace its pinned catalog |

File-plugin errors are deliberately sanitized. Raw exceptions, credentials and
private messages must stay out of routine logs and model results. Use deterministic
fixtures for debugging and share only redacted diagnostics. For deployment or
delivery failures, see [Troubleshooting](troubleshooting.md).

For upstream API and build details, consult the
[Pi extension reference for 1.5.2](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/extensions.md),
[Bun bundler reference](https://bun.sh/docs/bundler) and
[Docker Compose multiple-file reference](https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/).
RepoDesk's supported subset above governs compatibility with this application.
