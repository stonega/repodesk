# Codebase cleanup

## Scope and baseline

Started 2026-11-13 against `4bde2fc1229c87d279c5f54d187960732fbf0be8`,
equal to freshly fetched `origin/main`. This is a repository maintenance record,
not a claim of an exhaustive audit or a new release.

The working tree already contained a concurrent Pi 1.5.2 migration: dependencies,
the extension adapter/runtime, Browser pause handling, startup fixtures, runtime
checks, several tests, and related documentation. These changes are part of the
test environment, not cleanup work. Preserve them when reviewing or committing
this batch. The optional Code Truth fixture and implementation-status document
also changed independently during assessment. No branch integration is in scope.

Preserve tenant/actor authorization, deferred optional integration access,
configured endpoints and encryption keys, the single-image deployment layout,
and current tool, API, scheduling, delivery, and UI behavior.

Assessment coverage:

- Read project instructions, the documentation index, current architecture,
  implementation evidence, and local test setup.
- Mapped API/worker entry points, plugin construction, lazy Browser credentials,
  startup verification, and the stateless local runner client through CodeGraph.
- Reviewed repository-wide debt/suppression markers and relative Markdown links.
  The existing UI suppressions document accessibility or lifecycle requirements;
  they are not evidence that those safeguards should be removed. No missing
  relative Markdown file targets were found.
- Broader service internals, UI interaction/visual states, dependency reachability,
  migrations, and the complete documentation-to-behavior contract have not been
  exhaustively assessed. No code was deleted based on absent static callers.

Baseline checks used Bun 1.4.4, the installed dependencies, and a dedicated
PostgreSQL 17 container, independent of existing application/upgrade containers:

- `bun run check`: passes with nine existing warnings in
  `deploy/thread-incident/diagnostic.ts`.
- `bun run typecheck`: passes.
- `bun test` without a database: 893 pass, 863 skip, one failure in the optional
  Code Truth fixture's old Pi context assertions. That fixture was subsequently
  updated independently as part of the migration; this is not a cleanup fix.
- `TEST_DATABASE_URL=... bun test`: 1,649 pass, two Review Bot timeouts, 167 files.
  This baseline run overlapped ongoing edits; it is not immutable release evidence.

## Findings

| ID | Priority | Status | Evidence and consequence | Remedy and verification | Remaining uncertainty or deferral reason |
| --- | --- | --- | --- | --- | --- |
| CLEANUP-001 | Medium | verified | `src/server.ts` and `src/worker.ts` independently assembled the same plugin graph, including a shared Google/Search Console connection and lazy Browser configuration. Every integration wiring change required two matching edits. The injected startup fixture did not exercise that exact configuration-based construction. | Introduce `pluginRuntime` in `src/agent/plugin-runtime.ts`, use it from both entry points, and reuse all 16 startup scenarios against the configured graph. Run both compositions in the Node runtime contract. | Focused tests, all final project checks, and the built Node runtime contract pass on the recorded working tree. |
| CLEANUP-002 | Low | verified | `src/worker.ts` constructed two identical `LocalRunnerClient` objects for coding and Review Bot. The client only holds endpoint/token/transport and keeps no task/tenant state. | Share one process-local client without changing its request, error, or authorization behavior. Verify existing runner/review tests and final checks. | The 89-test focused runner/Review Bot/startup run and the final full test run pass. |
| CLEANUP-003 | Low | deferred | The historical incident diagnostic retains nine lint warnings, mostly `any`, and is outside the normal TypeScript include paths. | If promoted into a maintained operator command, type its input and test redaction with synthetic malformed results. | Retain incident-specific evidence; do not suppress warnings or widen this composition cleanup into diagnostic behavior changes. |

## Last completed batch

The focused startup checks pass in both injected and configured compositions:
two tests, 32 underlying owner/member scenarios, no optional network requests.
Configured cases use unavailable endpoints and an unavailable Browser token path;
the original injected cases also count credential lookups explicitly.

Final verification on the base revision plus the uncommitted cleanup and
pre-existing/concurrent migration changes:

- `bun run check`: passes, with the same nine historical diagnostic warnings.
- `bun run typecheck`: passes.
- `bun run build`: passes.
- `bun run test:runtime`: passes under Node v22.22.3 with Pi 1.5.2;
  `pluginStartupCases:16`, `configuredPluginStartupCases:16`,
  `externalStartupCalls:0`.
- Focused runner, Review Bot, and startup tests with the disposable database:
  89 pass, zero failures. Both baseline timeout cases pass on this run.
- Final `TEST_DATABASE_URL=... bun test`: **1,652 pass, zero failures across
  167 files**, including the optional Code Truth service tests, in 157.34 seconds.
  SHA-256 fingerprints of 630 source/test/configuration files are unchanged from
  the beginning to the end of this run. No test skips are reported.
- `git diff --check` and cleanup-document relative-link checks pass.

The earlier failures remain recorded above; the final run establishes the pass,
rather than a retry being substituted into an earlier failed total.

Cleanup paths: `src/agent/plugin-runtime.ts`, `src/server.ts`, `src/worker.ts`,
`scripts/fixtures/plugin-startup.ts`, `scripts/runtime-contract.ts`,
`tests/unit/plugin-startup.test.ts`, this record, and its documentation-index link.
The two scripts also retain pre-existing Pi migration edits. Changes are local
and uncommitted on the recorded base; no deployment or external action is implied.

## Next work and verification limits

The composition cleanup batch is verified. The remaining confirmed item is the
deferred diagnostic warning debt; the broader assessment scope below remains open.

No browser test is selected for this cleanup: compared with the recorded dirty
baseline, it changes backend construction and offline startup checks, not UI,
routes, permissions, browser fixtures, or dependencies. No earlier browser result
is reused. The independent Pi migration's broader acceptance is not established
by this cleanup. No Docker image or live-system validation is claimed.

Future assessment should trace the high-churn run/delivery and conversation paths
for duplicated state transitions, then examine dependency consumers and test/docs
drift with concrete evidence. These areas are unassessed scope, not confirmed
findings or authorization to replace existing behavior.
