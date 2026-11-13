# GitHub-distributed plugin research

Research date: **2026-11-13**. Status: research and recommendations, not shipped
RepoDesk behavior. The [proposed contract](../design/github-plugins.md) and
[delivery plan](../implementation/github-plugins-plan.md) are separate from the
[implemented Pi extension contract](../design/llm-extensions.md).

## Question and conclusion

How can one GitHub repository become one RepoDesk plugin, with little integration
work for its author and enforceable boundaries for a multi-tenant assistant?

Recommend a repository-root manifest, a prebuilt JavaScript bundle, a small typed
RepoDesk SDK and host-owned Pi adapters. Install an immutable repository snapshot;
run third-party code outside the application process with capability requests
mediated by application services. Keep the first contract limited to read-only
tools, declarative settings and optional instruction skills.

This is an architectural recommendation. It is not a claim that Pi, MCP or a
package manifest supplies isolation or RepoDesk authorization.

## RepoDesk baseline

The inspected checkout is main `4bde2fc`, equal to fetched `origin/main`, with
pre-existing uncommitted Pi 1.5.2 and composition cleanup changes. Findings below
describe that local checkout; they do not establish deployed behavior.

| Current mechanism | Evidence | Implication |
| --- | --- | --- |
| Operators register local entry files independently per workspace | `src/agent/plugin-service.ts`, `src/agent/plugin-config.ts` | GitHub package discovery and installation are new work |
| File entries declare tools, version, workspace grants and `execution: read-only` | `src/agent/plugin-config.ts` | The declaration does not constrain arbitrary Node code |
| Explicit Pi loading, selected hooks and per-invocation factories | `src/agent/extensions.ts`, [compatibility](../design/llm-extensions.md) | Useful internal adapter; broad Pi community compatibility is not established |
| Enabled entry bytes are hashed; imported dependencies are not recursively hashed | `src/agent/extensions.ts`, extension contract | A package digest must cover the executable dependency closure |
| Application guards, configuration revisions and a durable tool-call ledger | `src/agent/extension-execution.ts`, extension contract | Reuse these policies around a new runner instead of reimplementing them in plugins |
| GitHub skill import pins source and bundled text without executing scripts | [skills](../design/agent-skills.md) | Reuse source identity/review patterns; executable installation needs a different trust boundary |
| Built-in registration must work with failed or missing optional integrations | [startup contract](../design/llm-extensions.md#compatibility) | Read tool definitions from data; start third-party code only when called |

Markdown skills, trusted Pi extensions, application-owned integrations and the
proposed third-party package have different execution boundaries. Calling all of
them plugins in the product must not erase those differences in implementation.

## Primary-source comparisons

| System | Verified pattern | Adopt for RepoDesk | Boundary of the comparison |
| --- | --- | --- | --- |
| Pi 1.5.2 | Git/npm/local package sources and `package.json` resource declarations | Retain Pi as the agent runtime and internal tool adapter | Pi package installation does not add tenant policy or turn arbitrary extension code into a sandbox |
| Obsidian | Root manifest, source repository, versioned GitHub release files and a developer template | One repository per plugin, explicit metadata, small release contents and an author quickstart | Desktop plugin behavior does not establish safe execution inside a shared backend |
| VS Code | Manifest compatibility range and activation/deactivation lifecycle; activation can be demand-driven | Version the host API separately and load code on demand | Extension host APIs and UI contributions are much broader than this product needs |
| MCP | Named tools, input/output schemas and structured results; annotations from untrusted servers are untrusted | Use compatible tool data shapes and leave room for an adapter | MCP is not an installer, execution sandbox or grant of RepoDesk write authority |
| GitHub | Commit-addressed archives, installation-token Contents-read access and optional immutable releases | Pin repository ID, owner identity, full commit and content digest | A tag, a checksum or a public repository is not a safety endorsement |

Sources retrieved on the research date:

- [Pi packages, pinned v1.5.2](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/packages.md): sources, resource declarations and dependency handling.
- [Pi extensions, pinned v1.5.2](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/extensions.md): upstream extension reference. RepoDesk's narrower compatibility table remains authoritative for this application.
- [Obsidian manifest](https://docs.obsidian.md/Reference/Manifest): identity, version and minimum application version.
- [Submit an Obsidian plugin](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin): repository files, version matching and release assets. Its current community directory is a website; do not assume the older pull-request submission workflow.
- [VS Code extension anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy) and [activation events](https://code.visualstudio.com/api/references/activation-events): manifest, API compatibility and demand-driven activation.
- [MCP tools, 2025-11-25 protocol](https://modelcontextprotocol.io/specification/2025-11-25/server/tools): tool schemas, results and untrusted annotations. This is the specific protocol revision reviewed, not a claim about a future/latest revision.
- [GitHub repository contents and archives](https://docs.github.com/en/rest/repos/contents#download-a-repository-archive-zip): archive redirects, temporary private URLs and Contents-read permission.
- [GitHub commit lookup](https://docs.github.com/en/rest/commits/commits#get-a-commit): resolve a selected ref to a commit.
- [GitHub App installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation): repository and permission restrictions for installation tokens.
- [Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases): tag/asset protections and release attestations when immutability is enabled.

Context7 was used for Pi and GitHub documentation lookup. One retrieved GitHub
snippet incorrectly stated that archive downloads do not support GitHub App
tokens. The direct archive endpoint documentation explicitly lists installation
tokens and Contents-read permission; that primary endpoint reference takes
precedence. Private download URLs expire and must never be saved as source pins.

## Alternatives and tradeoffs

| Option | Developer effort | Platform consequences | Recommendation |
| --- | --- | --- | --- |
| Clone and load a Pi extension inside the worker | Low initially | Third-party code inherits worker credentials, files and tenant exposure | Retain only the existing manually reviewed local-extension path |
| Repository source plus committed self-contained bundle | Small build step and generated file in Git | No platform build execution, npm installation or release-asset provenance gap | Initial distribution contract |
| GitHub Release assets with provenance | Clean source tree and familiar releases | Must verify artifact-to-source provenance, asset identity and digest; release metadata alone is insufficient | Later distribution profile |
| Build source during installation | Conventional source-only repository | Requires a separate untrusted build service, locked dependencies, package-network policy and output verification | Defer until demand justifies the service |
| MCP-only plugins | Reuses existing tool servers | Still needs deployment, identity, authorization, lifecycle and source verification | Later adapter, not the initial package format |
| WASM runtime | Narrow runtime boundary | Larger SDK/tooling constraint and different library ecosystem | Reconsider if shared-kernel containers do not meet the deployment threat model |

The committed-bundle choice is deliberate: for the first version, every installed
byte can be reviewed at the pinned commit and no author build command runs during
installation. It costs repository size and generated diffs. A later attested
release profile can remove that cost without weakening source lineage.

## Decisions proposed for review

1. One root manifest and one logical plugin per repository; multiple tools and
   skills are allowed inside it. No monorepo subpath discovery initially.
2. A RepoDesk SDK for tool handlers; Pi is an internal adapter, avoiding a public
   dependency on the complete upstream extension API.
3. A sandbox runner with no direct network and a host capability broker. A child
   process, worker thread or Node VM alone does not meet this requirement.
4. Disabled installation, separate explicit enablement, operator-managed code and
   actor-specific connection checks at invocation time.
5. Manual reviewed updates with full commit/content pinning; retain old artifacts
   for audit and reviewed rollback, without reviving revoked grants or old runs.
6. No arbitrary plugin frontend, raw secrets, database handle, shell, Telegram
   delivery, model dispatch, event consumer or background daemon in the first API.

## Questions to prove before stabilizing the SDK

- Measure cold-start cost and memory for the chosen restricted container profile;
  prove resource, network, filesystem and cancellation enforcement on the actual
  supported Docker deployment. Shared-kernel isolation has residual host risk.
- Prove that Pi tool descriptions can be registered from a reviewed manifest
  without executing any third-party code, including when the runner is unavailable.
- Exercise the generic HTTP broker with a real read-only service design: origin,
  path, query, credential binding, pagination, response limits and account identity.
  HTTP GET is not proof of read-only semantics.
- Validate schema support against Pi 1.5.2 and the application's strict boundary
  validator; do not promise the entire JSON Schema vocabulary from a few examples.
- Validate the author workflow with two independently written plugins. SDK package
  names, CLI commands and API major `1` in the proposal are reserved draft names;
  no public compatibility promise exists yet.
