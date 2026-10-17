# Landing-page Codex acceptance environment

Prepared 2026-10-17 for an operator-authorized live VPS test.

- Test repository: https://github.com/stonega/repodesk-landing.
- Production page: https://repodesk-landing.pages.dev.
- Baseline: tag `baseline-v1`, commit `d5fb0c64ef6c73da4b1af8805f5f077f00f5462f`.
- Workload: [original optimization prompt](https://github.com/stonega/repodesk-landing/blob/main/examples/optimize-landing.txt).
- Test protocol: [acceptance and runtime comparison](https://github.com/stonega/repodesk-landing/blob/main/docs/implementation/codex-test.md).

The separate standalone project uses Bun 1.3.14, React Router v7 prerendering,
React 19, TypeScript strict mode, Tailwind v4 and Biome. The initial page includes
responsive navigation, labeled illustrative chat/PR content, workflow/principle
sections, FAQ, and real setup/source links. The production page returned HTTP 200
with prerendered content after Cloudflare's successful Git-backed build.

## Verified environment

Local check/typecheck, all three Bun unit tests, production build and seven Chromium
browser checks passed. Desktop/mobile full-page captures were inspected at 1440px
and 390px. One browser scenario is intentionally mobile-only and skipped on desktop.
[GitHub Verify](https://github.com/stonega/repodesk-landing/actions/runs/39007839841)
passed. The source is committed; the baseline tag remains fixed.

The existing VPS's actual Codex task image (Node 24.21.0, Bun 1.3.14, Git 2.39.5)
completed a fresh clone of that exact baseline, frozen dependency installation,
Biome, strict types, unit tests and production build. This isolated preflight used
2 CPUs/2 GiB, a read-only root, dropped capabilities, no-new-privileges and its own
disposable work volume. No model, GitHub or Cloudflare credential entered the test.
The temporary container/work volume were removed. Its log is on the VPS under
`/opt/repodesk/acceptance/repodesk-landing/preflight.log`.

The existing RepoDesk GitHub App could already access the new repository. With no
coding tasks active, a host-operator action selected only this additional repository,
recorded an operator audit, and synchronized the existing connected stonega account
through the application service. Current write access was confirmed. No membership,
account credential, execution policy or production image was changed.

## Docker live optimization

The VPS still uses Docker and its existing **Reviewed** policy. A concrete proposal
was created through `createRun` / `proposeCoding`, with explicit host-operator
provenance and normal repository/actor/audience checks. No Telegram update was
forged. The normal worker delivered its actor-bound approval to the existing
requester. The proposal has not been self-approved.

- Approval: `ff89f895-687a-4254-bcd6-ff9fb71fd551`.
- Parent run: `207c9672-4d51-4cb6-9369-5ecbb153c6d2`.
- Scope: add accessible code-question / fix / PR-review illustrative scenarios,
  preserve responsive layout/branding, add tests, run checks, create a reviewable PR.
- The requester approved through the real Reviewed flow. The task completed on
  Docker and created [PR #2](https://github.com/stonega/repodesk-landing/pull/2),
  with base `c3ac21835b95432421035b369dd13727c6f263e1` and head
  `28f1acfef7df5074fb8fcb542e074ff6f8858f78`. Both Verify jobs passed.
- Its automatic Cloudflare preview is https://51612f60.repodesk-landing.pages.dev.
  Desktop/mobile captures of that deployed result were inspected. The PR remains
  open for review; the optimized code has not been merged into production.

A single model run is an acceptance check, not a sandbox speed benchmark. The
separate [same-VPS comparison](../research/sandbox-vps-2026-10-17.md) records the
five-trial Docker/OpenSandbox fixture, isolated OpenSandbox model attempts and
the decision to exclude microsandbox. OpenSandbox's prepared-browser retry
published [PR #3](https://github.com/stonega/repodesk-landing/pull/3), with passing
Verify/Cloudflare checks and preview https://36cfc077.repodesk-landing.pages.dev.
Its receipts distinguish live tasks from
credential-free infrastructure tests.

## Verified Cloudflare integration

The Pages project has production/preview Git source settings, Bun/Node versions,
and a credential-free build command. Production was explicitly triggered through
the Pages API and succeeded. Initial baseline branch pushes produced no deployment;
the connection flag and CLI 403 were recorded as an unresolved gate at preparation.
The later real Codex branch push produced a successful deployment with trigger
`github:push` and matching PR head, plus the successful native Pages check. That
observed result resolves automatic preview acceptance; its exact recovery cause
was not established.

The existing installation is https://github.com/settings/installations/51937361.
Cloudflare project: https://dash.cloudflare.com/cc130c98ac6d6962e3ef3f4ab2b1be73/pages/view/repodesk-landing.
Keep source credentials in their existing stores. Do not copy the broad Wrangler
OAuth credential into GitHub Actions or a Codex container as a workaround.
An earlier explicitly triggered branch build also succeeded for `baseline-preview`, commit
`cb4988a168d129a3901194e3c3299284e276a16f`: https://baseline-preview.repodesk-landing.pages.dev
(immutable deployment https://b6572143.repodesk-landing.pages.dev). This verifies
manual preview creation, not automatic push triggering.

The initial source remains pinned by `baseline-v1`. Both live runtimes checked out
the docs-only follow-up `c3ac21835b95432421035b369dd13727c6f263e1`. Later acceptance
receipt updates do not move that tag. Record the actual checked-out SHA for each
future trial, rather than assuming the baseline tag equals current main.
