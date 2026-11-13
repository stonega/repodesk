# GitHub plugin preview verification

Local feature delivery, 2026-11-13. This record covers the implemented read-only
preview and does not claim a production deployment or independent-author pilot.
See [delivery ledger](github-plugins-plan.md) and [design decisions](../design/github-plugins.md).

## Source and toolchain

Implementation started from `4bde2fc` in the separate
`/home/stone/Web/repodesk-plugin-system` worktree to preserve concurrent changes.
It was rebased onto fetched `origin/main` `44f32bd`, retaining the unified
`pluginRuntime` composition and Pi **1.5.2**. Application/worker share that factory;
the worker receives an HTTP runner client, never Docker access.

Bun **1.3.14** builds/tests the application and independent author package. Local
Node **22.22.3** and image Node **24.21.0** run the runtime contract. No new root
runtime dependencies are added. Zod/YAML/marked already existed; the portable CLI
bundles the author-side pieces with third-party notices. ZIP inflation uses Node
zlib's actual output bound in addition to untrusted archive declaration checks.

## Acceptance evidence

The final `TEST_DATABASE_URL=... bun test --timeout 30000` run passes **1,712 tests
across 175 files**, with **8 gated Docker tests skipped** and **0 failures**
(212 seconds). Those eight Docker cases are covered separately by the 19-case
exact-image selection below. The full run includes the five Code Truth service
test files and the author template test; it is not a unit-only run.

Final targeted checks pass: Biome (only nine pre-existing incident-script warnings),
strict TypeScript, build, local runtime contract and independent template verifier.
The full 17-case `admin.e2e.ts` sequence passes; the final package/catalog selection
passes seven cases, including the added loading/error recovery scenario. This is
24 distinct selected browser cases in total. The 19-case exact-job/installation
selection passes with fixture source/services, and the exact supervisor image
passes offline authentication/health/Docker-client smoke. The exact app image
passes its offline runtime contract with 16 injected + 16 configured startup cases
and zero external startup calls. Private token initialization and writable UID-1000
artifact storage pass with read-only containers/private volumes. The opt-in Compose
configuration validates; no stack is deployed.

A representative local exact-job run measures approximately 0.5–0.8 seconds for
word-count startup/execution and approximately 1 second for the GitHub broker
fixture. These individual test observations include Docker CLI/daemon latency;
they are not a production latency benchmark or service-level commitment. Resource
inspection verifies memory+swap 256 MiB, 1 CPU, 32 PIDs, non-root UID, no network,
read-only root, all capabilities dropped and no-new-privileges. Cancellation and
expiry fixtures verify container removal rather than only an error return.

| Locally built image | Immutable ID |
| --- | --- |
| App | `sha256:2cfaea2e5925c1655d794d7f2e88cae34074527d9ffad6541bfd1594937c2ccf` |
| Restricted job | `sha256:673c6152e0cfb311afe1300d9361858dc99b251ab2ce2e9d7bd70caf0de9fe7f` |
| Private supervisor | `sha256:276face3d822edbf9e14b4b4d86f4875e58b8a487b910555709f2b0279273fd5` |

These images contain the tested runtime/build inputs. Later changes only record
verification/documentation. They remain local verification artifacts, not release
artifacts reachable from remote main.

 The initial full run was interrupted (exit 143); it is not a full pass.
A subsequent complete run exposed an existing Code Truth initializer error-text
regression caused by helper extraction. The wrapper now preserves the previous
contract, and its three targeted tests pass. The final full run validates the fix and the final ZIP/rollback policy changes.

Deterministic source/HTTP tests use synthetic GitHub/private-source transports,
pinned fake DNS and service responses. The Pi/Executor integration uses a local
fixture model stream and no live Telegram or model account. With
`PLUGIN_TEST_IMAGE` set, package management/invocation tests use the real private
client/service and exact Docker job image, retaining fixture service data.

The independent-template verifier copies `templates/plugin` outside the checkout,
installs its frozen lockfile and runs lint, strict types, tests, build, validation
and the trusted offline example. It compares the generated contract and bundle
against their committed bytes. API registration does not import author code.
Both production startup compositions run 16 owner/member cases with enabled
packages, stale/denied permissions, failed dependencies and missing configuration,
requiring a greeting and zero external calls or credential reads.

## Browser selection and visual acceptance

The implementation target is `44f32bd`; its feature/UI changes are compared with
that source. No earlier browser pass is substituted for changed flows. The full
serial `admin.e2e.ts` file is selected because its shared setup is a prerequisite
for local plugin, workspace-switching, authentication and modal tests. Selecting
those later tests alone initially skipped the setup prerequisite and failed; that
partial attempt is not a pass. The complete file subsequently passes.

The selected files are `admin.e2e.ts`, `plugin-packages.e2e.ts` and
`plugins-catalog.e2e.ts`. Package-only CSS adjustments receive a fresh focused run;
unchanged admin results are reused after those scoped adjustments. Other browser
files and live Telegram clients are outside this bounded verification.

Applicable UI rules and observed acceptance:

| Rule / scope | Acceptance |
| --- | --- |
| Compact Installed catalog, hidden Markets | GitHub packages join existing cards; no Markets heading/footnote/gap; local files remain reachable through New |
| Saved summaries separate from modal editors | Details contain readable saved values and connections; only Edit opens forms; cancel discards draft |
| Shared plugin heading and title switch | Explicit enablement is independent of configuration; new/applied versions stay disabled |
| Modals, secondary actions and feedback | Shared Modal/Select/Actions/Toasts; named dialogs, focus return, pending dismissal/duplicate lock, inline stale-save error |
| Card spacing and top-right actions | Scoped gaps own first/last padding; version actions stay at the heading's right; long source/digest rows wrap on mobile |
| Visible layout while data is unknown | Configuration/version headings stay visible, unknown enablement is a skeleton and actions remain disabled; read failures keep retry available |
| Desktop/mobile themes | Source preview and saved details inspected at 1280px light and 390px dark; catalog tests cover light/dark at both widths |

Screenshots/traces are local Playwright artifacts under `test-results/`, not
published product assets. Browser fixtures verify install consent/default disabled,
saved/editor separation, cancellation, inline conflicts, explicit enablement,
no-update state, connection summaries without secret echo, pending/focus behavior,
reviewed rollback, removal and load-error recovery.

## Operational boundaries and open release gates

- The copyable template/SDK/CLI are local preview assets. No npm package or official
  separate GitHub template repository has been published.
- Public/private GitHub source authorization uses deterministic fixtures. A real
  GitHub App/private repository and two independently authored remote repositories
  still require an operator-controlled pilot.
- No live Telegram message, model call, deployment, webhook registration or account
  connection is performed. Exercise the actual user conversation and real read-only
  service paths before a production rollout.
- Images and the opt-in Compose overlay are locally tested. Production deployment
  must use a clean immutable commit already reachable from `origin/main` and repeat
  exact-image gates through the normal release process. Local integration does not
  establish remote-main reachability or release approval.
- Containers share the host kernel and the private supervisor controls Docker.
  Resource/deadline/cancellation and expired-job cleanup tests do not prove isolation
  against kernel vulnerabilities or Docker-daemon outage. Validate restart/daemon
  recovery and removal of labelled tasks on the target deployment before enablement.
- Personal HTTP connections need a verified linked panel identity; a standalone
  Telegram member connection editor, OAuth, writes, persistent author state,
  events/schedules and background callbacks are outside the delivered profile.
