# Develop a GitHub plugin

RepoDesk's repository plugin profile is a **read-only preview**. One GitHub
repository contains one plugin. Authors supply a manifest, source and a committed
Node ESM bundle. Operators review an immutable commit before installing the plugin
into a workspace. Installation, updates and rollbacks leave it disabled until an
operator explicitly enables it.

This profile is separate from [trusted local Pi extensions](local-plugins.md).
The preview SDK is supplied with the template; no npm publication is required.
Public SDK publication and an official hosted GitHub template are release steps.

## Start from the supplied template

Copy the complete `templates/plugin/` directory from your RepoDesk distribution to
an empty repository, including hidden files. It is an independent author package;
you can move it outside the RepoDesk checkout. Use Bun **1.3.14**:

```sh
bun install --frozen-lockfile
bun run generate
bun run check
bun run typecheck
bun test
bun run build
bun run validate
bun run example
```

Set `repository`, `publisher`, `id`, `name` and `description` in
`repodesk.plugin.json`. The repository field must be the HTTPS GitHub repository
root. Set the same SemVer version in the manifest and `package.json`.

```text
repodesk.plugin.json          Manifest and schema authority
package.json / bun.lock       Pinned author tooling
src/index.ts                 Handler implementation
src/generated/contract.ts    Generated input, output and settings types
dist/plugin.mjs              Committed self-contained Node ESM executable
.repodesk/                   Preview SDK, CLI, schema and third-party notices
input.json / fixtures.json   Trusted offline example inputs/responses
README.md / LICENSE          Required review and license information
tests/                       Offline deterministic author tests
.github/workflows/check.yml  Validation and bundle rebuild check
```

The CLI builds `src/index.ts` into the manifest's `runtime.entry`. It never
installs runtime dependencies on the platform. Bundle any author dependencies into
that entrypoint. Keep the generated types and executable in Git. The CI example
rebuilds them with the pinned compiler and fails on drift.

The `example` command imports **trusted local code with your developer account's
permissions**. Its output identifies it as an offline harness without OS isolation.
Use it only with code you trust. Fixture broker responses make no service calls;
production execution uses the restricted runner instead.

## Implement a handler

The template contains a working word counter:

```ts
import { definePlugin } from "@repodesk/plugin-sdk";
import type { Contract, Settings } from "./generated/contract.ts";

export default definePlugin<Contract, Settings>({
  tools: {
    async count_words({ text }, context) {
      context.signal.throwIfAborted();
      const count = text.trim().split(/\s+/).filter(Boolean).length;
      return {
        content: [{ type: "text", text: String(count) }],
        structuredContent: { count },
      };
    },
  },
});
```

Export only a plugin definition with the exact handlers declared in `tools`.
Missing or additional handlers fail at invocation. Module import must stay quick
and free of I/O. There are no activation hooks, routes, background callbacks,
storage APIs, shell helpers or interactive Pi UI methods in this SDK.

The host exposes tools as `rdp_<numeric GitHub repository ID>_<local tool name>`.
Local names use lowercase letters, numbers and underscores, starting with a letter,
with at most 32 characters. Authors use local names in their code and guides;
the host owns the numeric prefix. Copying another repository's manifest ID does
not copy its installation identity.

## Manifest contract

The template includes `.repodesk/sdk/plugin/manifest.schema.json`. The CLI's
semantic validator also checks schema limits, paths, capability relationships and
linked guide files. Installing a plugin never imports its code or executes
package scripts.

Required fields are `schemaVersion: 1`, preview `apiVersion: "1"`, identity and
license information, `runtime`, `capabilities`, `settingsSchema`, `tools` and
`skills` (an empty array is valid). Unknown fields, API versions, capabilities and
schema keywords fail closed. Use `metadata` for optional string metadata.

Each tool declares a title, description, `effect` (`compute` or `read`), capability
ceiling, `inputSchema` and `outputSchema`. The latter describes `structuredContent`.
Both roots must be objects. The supported JSON Schema subset has:

- Types: object, array, string, integer, number, boolean and null.
- Objects: declared properties, required names and `additionalProperties: false`.
- Arrays: `items`, `minItems` and a required bounded `maxItems`.
- Scalars: enums, defaults, string length and numeric minimum/maximum.
- Descriptions and titles. No `$ref`, remote schemas, combinators or coercion.

Settings use a flat object of scalar fields or bounded scalar arrays. The panel
renders these as ordinary controls. Optional `settingsUi` labels, help and order
may refer only to declared settings. Keep secrets out of settings; use connections.
`generate` derives TypeScript from the manifest, so edit the manifest first and
regenerate before changing handler signatures.

The CLI returns fixed `plugin_manifest_invalid` or `plugin_package_invalid` errors
for unsupported contracts or incomplete packages. It does not print private
exceptions, input or credentials. Check the machine schema, required inventory,
version agreement and linked paths when diagnosing these errors.

## Read through host capabilities

Declarations limit what a tool can request. They do not grant resource access.
Operators grant requested capabilities separately, and every broker call checks
the current member, workspace, run and connection policy again.

| Capability | Author API | Current access requirements |
| --- | --- | --- |
| `github.metadata.read` | `context.github.getRepository({ repositoryId })` | Selected workspace repository and invoking member's current verified GitHub read permission |
| `http.read` | `context.http.request(connectionId, { path, query })` | Declared exact destination/path/query keys and an explicit current connection binding |

GitHub reads return `url`, `stars`, `forks`, `subscribers` and `fetchedAt`.
The `examples/plugins/repository-insights/` package in the distribution demonstrates
this API with fixture responses. GitHub installation-source access is independent
of permission to read repository data during a conversation.

HTTP connections declare a local ID, display name, `member` or `workspace` scope,
`none` or `bearer` authentication, and approved request rules. For example:

```json
{
  "id": "reports",
  "name": "Reports",
  "scope": "workspace",
  "auth": { "type": "bearer" },
  "requests": [{
    "origin": "https://reports.example.com",
    "paths": ["/v1/summary"],
    "queryKeys": ["project"]
  }]
}
```

The preview supports HTTPS GET on port 443 with exact paths and query-key
allowlists. Paths cannot overlap within a connection. Redirects, arbitrary headers,
encoded traversal and private/local network addresses are rejected. DNS results
are checked and the request pins an approved public address. Responses contain
only HTTP status and bounded JSON, with no upstream headers or cookies.

Bearer tokens stay encrypted on the host and are sent only to the approved
service. Authors never receive them. An approved endpoint can receive tool
arguments through query values; explain that disclosure in the plugin README and
request review. Do not describe arbitrary GET endpoints as safe merely because
the transport is read-only; select service endpoints intended for reads.

A workspace connection lists the allowed members and group destinations explicitly;
private-only is the default. A personal connection belongs to the verified linked
panel member and works only in that member's private conversations. This preview
does not supply a Telegram connection-setup Mini App for members without a linked
panel account. Operators can configure workspace bindings for selected members.

## Companion guides

Declare a guide as `{"path":"skills/<slug>/SKILL.md"}` in `skills`. Its YAML
frontmatter requires `name` and `description`; optional `allowed-tools` contains
only this plugin's local tool names or the host's `load_guide` name. Other supported
frontmatter fields are license, compatibility and string metadata.

Use relative Markdown/text links inside that guide directory for supporting
resources. The host stores only approved linked files, exposes its own authorized
`rdp_<repositoryId>_load_guide` tool, and rewrites local tool references when serving
the guide. Guide text is external data and grants no permission. `load_guide` is
reserved when guides are present; author tools are then limited to 31.

## Runtime and limits

The private supervisor creates a fresh container per tool call. The plugin has
no app credentials, host mounts, Docker socket or direct network. Its root is
read-only; temporary scratch space is discarded after the call. The worker
communicates with the private supervisor and remains responsible for current
application authorization.

| Limit | Preview default |
| --- | --- |
| Invocation, including module import | 30 seconds |
| Bundle | 5 MiB |
| GitHub archive / expanded repository | 10 MiB / 32 MiB, up to 512 files |
| Manifest / tool input / settings | 64 KiB each |
| Tool result / protocol frame | 256 KiB each |
| Broker requests per invocation | 10 |
| HTTP read | 10 seconds, 100,000 response bytes |
| Sandbox | 256 MiB memory, 1 CPU, 32 PIDs, 16 MiB scratch |
| Supervisor | 4 concurrent invocations |
| Guide | 16 KiB main file, 32 linked resources, 256 KiB total per guide |

Respect `context.signal`; keep results concise and include source URLs/timestamps
when reporting fetched facts. Use only fixed declared `diagnosticCodes` with
`context.diagnostics.emit`. Never emit raw private input, tokens or exceptions.
These containers share the operator's kernel; operators must maintain the host
and trusted Docker supervisor. See [operator setup](plugin-administration.md).

Typical invocation errors are `plugin_input_invalid`, `plugin_settings_invalid`,
`plugin_result_invalid`, `plugin_permission_denied`, `plugin_connection_required`,
`plugin_timeout`, `plugin_cancelled`, `plugin_unavailable`,
`plugin_protocol_invalid`, `plugin_execution_failed` and `plugin_outcome_unknown`.
An uncertain call is never automatically repeated. Completed results are reused
only while the saved installation and current run policy still permit it.

## Publish and install a version

1. Run author checks, build, validate and review the committed executable.
2. Commit the entire required inventory and source. Create a stable `vX.Y.Z` tag
   matching both versions; push it without moving a previously published tag.
3. The operator opens Plugins → New → GitHub repository, enters the repository
   root and optionally a version tag or full 40-character commit, and previews it.
4. Review numeric repository/publisher identity, commit, bundle, capabilities and
   any external data destinations. Install, configure, grant and enable explicitly.

With no ref, the installer checks up to 100 returned tags and the 20 highest stable
`vX.Y.Z` candidates for a supported manifest. If the tag listing reaches its bound,
specify a ref explicitly. Prerelease/build-metadata tags require an explicit ref.
Nested repository URLs, branches and short commit hashes are unsupported.

Updates are manual previews. Reusing a published version with different installed
contents is rejected. Rollback is a fresh reviewed installation of a retained
version at its immutable commit; it does not restore historical grants or secrets.
Disabling, updating, removing or changing connections invalidates dependent work.
See [plugin administration](plugin-administration.md) for setup and recovery.
