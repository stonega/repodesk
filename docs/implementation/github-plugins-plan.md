# GitHub plugin delivery plan

Status: **read-only preview implemented locally; pilot/publication gates open,
2026-11-13**. The implementation is on `feat/github-plugin-system`, based on
`origin/main` `44f32bd` (Pi 1.5.2). No live Telegram/GitHub connection, production
deployment, hosted template creation or npm publication is performed by this work.
See the [RFC](../design/github-plugins.md), [developer guide](../user/plugin-development.md)
and [operator guide](../user/plugin-administration.md).

## Delivery ledger

| Slice | Local delivery | Evidence / remaining acceptance |
| --- | --- | --- |
| P0 | Strict manifest/schema subset, SDK, generated types, CLI and two bundled examples | Deterministic contract/guide/protocol tests; portable template checked from an independent temporary directory |
| P1 | Private supervisor, HTTP client, bounded JSON-RPC, immutable networkless per-call Docker job, deadline/cancel cleanup and expiry sweep | Exact-image fixtures exercise both plugins, host/network/filesystem denial, bounded resource configuration and interrupted-job cleanup; daemon outage remains an operator recovery boundary |
| P2 | Fixed-endpoint GitHub source resolution, numeric repository/owner identity, tag recheck, bounded ZIP extraction, private tenant cache | Public/private source transports, hostile archives, moved identities/tags and corrupted cache use deterministic fixtures |
| P3 | Workspace records and authenticated APIs, persisted previews, disabled install, revision-bound apply/settings/grants/connections, manual updates and fresh rollback, removal/collection | Disposable PostgreSQL tests cover operator/CSRF/tenant, restart/idempotency/revision, encryption and invalidation |
| P4 | Static Pi adapter and current GitHub/HTTP broker, existing durable result ledger and run policy pins | Production Pi/Executor with fixture model, result reuse/uncertain-call denial and revocation; both startup compositions include enabled packages with zero optional startup I/O |
| P5 | Installed catalog/details/modal editors, source review, connection summaries, independent template/CI, developer/operator guides | Focused browser desktop/mobile scenarios and author commands; official hosted template and npm releases remain unpublished |
| P6 | Local release-check assets and opt-in Compose overlay | Production deployment, two independently authored remote repositories, real Telegram/service pilot and operational acceptance remain explicit release gates |

The implemented preview makes the complete local install-to-call path reviewable.
It does not establish stable API 1 or claim independent-author/live pilot acceptance.
Detailed commands, source/image identities, selected browser baseline and test
results are recorded in [verification](github-plugins-verification.md).

## Delivery boundaries

Keep the standalone application and its existing PostgreSQL policy/durable-run
services. A restricted execution runner is justified by a distinct trust boundary;
it does not require turning the whole application into a plugin framework.
The optional supervisor has its own deployment trust boundary. Existing dependencies
are reused; the author template pins its own development tools.

Initial acceptance: an independent author copies a GitHub template, implements a
read-only handler, commits the bundle and tags a release. An operator pastes the
repository URL, reviews the exact code/capabilities, installs disabled, configures
and enables it. A Telegram run invokes it with current resource access and durable
results. A broken plugin or unavailable runner cannot break an unrelated greeting.

## Next delivery objective

Deliver the first complete read-only repository-plugin path:

```text
Author copies template and implements handler
→ validates manifest, generates types and builds the committed bundle
→ operator previews an exact GitHub commit and requested capabilities
→ installs disabled, configures and explicitly enables
→ Pi calls the tool in a restricted sandbox
→ current application authorization and durable result handling apply
```

Use two milestones rather than treating the entire ecosystem as one release:

| Milestone | Scope | Exit condition |
| --- | --- | --- |
| A: executable local proof | P0–P1, preview SDK/CLI, manifest/type generation, offline author harness and restricted per-call runner | Two fixture plugins build and execute through the runner; hostile/denied/cancelled cases fail safely; all service responses are fixtures |
| B: integrated read-only beta | P2–P6, GitHub preview/install, workspace controls, Pi/broker integration, admin UI, complete template and operator pilot | Two independently authored repositories complete installation through a test Telegram run; exact-image, authorization, recovery and UI gates pass |

Milestone A is an internal proof. It does not enable GitHub installation for users
or establish stable API `1`. Milestone B includes approved HTTP reads as well as
the GitHub metadata adapter; generic HTTP access cannot bypass its connection,
destination and data-disclosure checks. Writes, OAuth, webhooks, storage and
background callbacks remain outside both milestones.

## Source preparation

At planning time, fetched `origin/main` was `4bde2fc`; implementation was isolated
in `/home/stone/Web/repodesk-plugin-system` and rebased onto `44f32bd`.
At that point the shared worktree also contained unrelated uncommitted Pi/runtime
changes and the plugin documentation work. Do not treat that combined dirty tree as a tested
source baseline for new runtime changes.

Before the first implementation batch:

1. Fetch and record the current remote main commit, branch/worktree state and
   actual Pi/dependency versions. Work in an isolated branch/worktree when the
   shared checkout still contains other work; preserve all existing changes.
2. Carry over only the relevant reviewed plugin documents. P0's manifest/protocol
   work can proceed independently of pending Pi changes. The P4 adapter must use
   the dependency version in its recorded integration target; revalidate if it changes.
3. Record the actual passing checks used as the batch's baseline. Earlier Pi
   upgrade or cleanup results do not automatically cover later plugin changes.
4. Before integration or release, follow the existing source-lineage checklist.
   Deployment and package/template publication remain explicit release actions;
   planning this work does not publish artifacts or connect live services.

## First implementation batch: P0

The original P0 checklist below is retained for contract review. P0–P5 now have
local implementations; the delivery ledger and verification report identify their
actual evidence and open gates. The proposed SDK/CLI can live in focused
directories in this repository for development; separate publication does not
require a monorepo migration or another deployed application.

| Task | Concrete output | Dependency | Acceptance |
| --- | --- | --- | --- |
| P0.1: manifest contract | Versioned local JSON Schema, semantic validator and valid/invalid package fixtures | Recorded source baseline | Strict unknown-field/API/capability handling; bounded resource paths, duplicate tools and schema subset checks; no plugin import or remote schema lookup |
| P0.2: invocation protocol | Versioned request/response schemas for initialize, invoke, broker requests, cancel, result and fixed errors | P0.1 capability vocabulary | Explicit host binding for workspace/actor/run/call/generation/digest; unknown, forged, duplicate, oversized and late frames are rejected |
| P0.3: author SDK/CLI | Preview `definePlugin`, generated input/output/settings types and local validate/generate/build commands | P0.1–P0.2 | A fresh author package compiles; no Pi runtime bundled into plugin; undeclared/missing handlers and incompatible output fail; no ambient secrets or direct host-service objects |
| P0.4: two offline examples | Pure word-count package and GitHub metadata package using a fake host broker | P0.3 | Readable self-contained bundles; no runtime package install; metadata fixture supplies source URL/time; unavailable capability and invalid input are exercised |
| P0.5: contract verification | Offline author harness, deterministic test command and generated-output drift check in CI | P0.4 | Valid calls succeed; denied capability, malformed result and cancellation fail predictably; module import/registration makes zero external calls |

The harness in P0 proves interface behavior, not OS isolation. Mark that distinction
in its output and documentation. P1 must prove the execution boundary before any
untrusted package is enabled. Do not expose the harness as an installation bypass.

P0 review artifacts are the schema, protocol shapes, actual generated types,
SDK/CLI command output and both fixture packages. Resolve any API mismatch there
before implementing the installer or promising a stable SDK version.

## Following batches and dependency gates

| Batch | Work package | Required predecessor | Reviewable result |
| --- | --- | --- | --- |
| 2 | P1: runner, supervisor and restricted broker transport | P0 | Exact runner image executing both packages; host environment/files/network probes denied; descendants terminated on cancellation; cold-start/resource measurements recorded |
| 3 | P2: GitHub source/artifact service | P0 schema/source rules | Preview and immutable cache with private-source and hostile-archive fixtures; no code executes during download/validation |
| 4 | P3: workspace persistence and APIs | P2 | Disabled install, revision-bound apply/update, settings, enable/disable/remove and reviewed rollback; restart and stale-preview tests |
| 5 | P4: Pi and authorized service integration | P1 and P3 | Production-composition tool invocation, GitHub/HTTP broker checks, durable results, revocation and zero-I/O startup coverage |
| 6 | P5: admin flow and developer package | P4 | Saved summaries/modal editors, permission/source review, tested author quickstart and a template ready for controlled publication |
| 7 | P6: read-only pilot and release evidence | P5 and all exact-image gates | Immutable main source, tested app/runner artifacts, independent author feedback and a recorded disable/update/recovery drill |

P2's data-only work can be developed independently of P1 once P0 is fixed. This is
a way to separate the implementation concerns. Activation and P4 integration
still require both branches of the dependency graph to pass.
Use small reviewable changes, keeping schema/protocol, runner, installer, state,
integration and UI changes distinguishable.

Do not assign calendar release dates before P1 measurements and the first author
trial. Re-estimate after those results, with the remaining acceptance gates visible.

## Dependency-ordered slices

| Slice | Deliverable | Completion evidence |
| --- | --- | --- |
| P0: contract proof | Versioned manifest schema, schema subset, capability vocabulary, typed SDK and offline harness | Pure tool and scoped GitHub metadata tool pass schema/input/output, denial, cancellation and missing-handler fixtures; no SDK major stability claim yet |
| P1: execution boundary | Host runner image, supervisor and bounded broker protocol; no network/app credentials inside plugin | Exact-image hostile fixtures prove import deadlines, CPU/memory/PID/filesystem/network limits, forged/late frames, cancellation and unavailable-runner isolation |
| P2: source and artifact service | GitHub source preview, bounded extraction, canonical installed-inventory digest and local immutable cache | Public/private source fixtures, numeric identity, moved tags, ownership transfer, archive traversal/bombs/links and auth-on-redirect rejection pass |
| P3: workspace installation | Additive records, disabled installation, settings and grants, update/disable/remove/rollback APIs | Operator/tenant/CSRF/revision boundaries, restart recovery, duplicate requests, atomic activation and current authorization pass |
| P4: Pi and broker integration | Static catalog adapter, existing durable ledger, GitHub read and approved HTTP read | Greeting performs zero external startup calls; permission loss, result reuse, uncertain calls, package updates and cross-workspace isolation pass through production composition |
| P5: admin and developer experience | Shared modal/summary UI, official template repository, SDK/CLI release, developer/operator guides | Two independently authored plugins complete the install-to-call path; focused desktop/mobile browser cases and author quickstart pass |
| P6: controlled pilot | Reviewed artifact rollout, exact-image checks and recovery drill | Known plugin source commit, host/runner image digests, actual source auth and read-only service behavior recorded; no blanket third-party compatibility claim |

P1 and P2 do not depend on each other's implementation, but neither alone permits
execution. P4 requires the security/persistence boundaries of P1–P3. Publish stable
SDK `1` only after the independent-author and recovery checks; start development
with a preview version and explicit compatibility limits.

## Likely application touchpoints

These are implementation seams identified from the local source, not instructions
to modify pre-existing uncommitted work:

| Area | Proposed change |
| --- | --- |
| `src/agent/plugin-config.ts` | Keep legacy file schema; add a distinct package installation/config schema |
| `src/agent/plugin-service.ts` | Reuse operator/workspace policy and optimistic revisions; delegate source/artifact jobs to a focused service |
| `src/agent/extensions.ts` | Preserve trusted Pi-file loading; add host-owned static adapter definitions without importing third-party entrypoints |
| `src/agent/extension-execution.ts` | Reuse tool reservation/result recovery and current guard; include immutable package identity in the bound invocation |
| Production server/worker composition | Supply the runner and broker lazily; no optional startup I/O or credential lookup |
| Existing GitHub source/skill import services | Reuse fixed-endpoint access and source review concepts where suitable; executable install uses its own artifact validation |
| Database/migrations | Add tenant-owned package/job/connection references; retain existing empty-registry override and file fallback behavior |
| `scripts/fixtures/plugin-startup.ts` | Include static package tools, failed runner, missing secrets, ordinary members and stale/denied permissions |
| `scripts/runtime-contract.ts` | Run the production composition startup checks in the exact application image; separately test the exact runner image |
| `web/` plugin screens | Reuse detail layout, dialogs, toast handling and saved summaries; package editor is a separate source type |

Avoid a parallel permission engine inside the SDK, an author-supplied server router,
unrestricted dependency injection, a generic database API or a broad framework
rewrite. Pi still owns the agent loop; application services still own policy/state.

## Template and SDK publication checklist

The following assets must exist before the platform offers a third-party quickstart:

1. A GitHub template with strict TypeScript, pinned Bun/toolchain, Biome, committed
   self-contained bundle and CI that checks rebuild equality. Include both handler
   and broker-denial examples, README, changelog, license and security policy.
2. Versioned manifest JSON Schema shipped with the CLI, generated input/output and
   settings types, and human-readable validation errors. No remote schema fetch is
   needed at install or invocation time.
3. A minimal SDK with exactly the advertised context/capabilities. Its bundle has
   no access to a live host outside the test harness or bound invocation channel.
4. Offline fixtures for source install, pure compute, GitHub read and external
   HTTP read; fake credentials stay outside the plugin and produce no network.
5. A developer guide distinguishing local harness, compatible host versions,
   source tags, immutable commits, data disclosure, limits, errors and debugging.
6. An operator guide for code review, enablement, member/workspace connections,
   manual updates, cancellation, removal, retention and fresh reviewed rollback.
7. Clear compatibility notes: today's local Pi extensions keep their current
   supported headless subset; the new SDK is a different execution profile.

Publish the SDK and template only after their documented commands work from a
fresh checkout. The checked-in `templates/plugin` includes the working preview SDK/CLI; illustrative
RFC commands are not a separately published CLI.

## Verification matrix

| Boundary | Required deterministic cases |
| --- | --- |
| Source identity | Fork copying a slug, repository rename/transfer/recreation, nested URL rejection, private-source grant loss, moved/lightweight/annotated tags |
| Artifacts | Missing/stale bundle, unknown schema/API, malformed schemas, undeclared handler, truncated archive, oversized/duplicate/escaped paths, links/devices/submodules and corrupted cache |
| Policy | Ordinary member cannot install; other operator/workspace denied; forged actor/run/approval fields denied; per-tool capability ceiling; another member's connection cannot be used |
| Networking | Unapproved paths/query keys/origins, encoded traversal, private IPv4/IPv6, DNS rebinding, redirect credential stripping and response/header leakage |
| Isolation | Hung/malicious top-level import, direct network attempts, environment/filesystem probes, subprocess/resource abuse, broker replay/oversize/unknown methods and supervisor loss |
| Durability | Duplicate preview/apply/call IDs, crash before/after reservation/result commit, uncertain request never replayed, expired job lease and abandoned artifact cleanup |
| Revocation | Disable/remove/update during call and delivery; connection/membership loss before stored-result reuse; rollback cannot restore old grants or revive runs |
| Startup | Ordinary greeting with enabled packages and failed/missing runner, credentials or upstream; zero external startup calls through actual production composition |
| Interoperability | Generated schema/type/bundle agreement, pinned Pi adapter, bundled skill tool-name mapping, fixed diagnostic codes and no raw logs |

UI work must first translate the RFC's applicable preference headings into acceptance
criteria. Verify saved display separately from install/edit, including preview,
no-tags/no-updates/empty settings, loading, pending, denied and failed states at
desktop/mobile widths. Browser assertions must exercise actual separation of
saved summaries and modal editing, explicit enablement, stale-preview rejection,
connection identity and persistence across reload/workspace switching.

For implementation changes run `bun run check`, `bun run typecheck`, `bun test`
and `bun run build`. Deployment slices additionally require Docker builds,
`docker compose config`, service smoke checks and exact application/runner image
contracts. Select browser cases from a documented verified baseline using the
[release procedure](release-runbook.md#select-browser-tests-from-the-change);
expand for shared authentication, policy, routing or fixtures. Do not report an
isolated runner test as production-composition coverage.

## Deferred profiles and stability decisions

After the read-only pilot, evaluate attested release assets and OAuth separately
from action proposals/approved writes. Durable plugin storage, webhook events,
schedules and long-running jobs each need explicit tenant policy and recovery
design. Do not add author timers or direct side effects as shortcuts.

Before P0 exits, settle the schema subset and compatibility rules. Before P1 exits,
settle the supported sandbox threat model and measured resource defaults. Before
P5 exits, settle SDK/CLI package names, update wording and whether committed bundles
remain acceptable for the first public distribution profile. Each decision gets
an explicit contract revision; none is silently inferred from this research.
