# Reviewed repository incorrectly routed to a Direct Codex task

Date: 2026-10-06. Observed deployment: v0.1.18. Local fix pending release.

## Impact and evidence

Two Telegram requests for the selected `stonega/wallshader` repository each
attempted `start_development_task` twice. All four transcript tool results reported
`extension_tool_failed`. No continuous task was created. The selected repository
and current maintainer grant existed; its saved configuration omitted development
policy, which defaults to Reviewed. The app, worker and runner were healthy.

## Cause

The Codex extension registered the Direct start tool unconditionally and included
Reviewed repositories in its target description. Pi selected that tool despite the
target's policy. `startDevelopment` rejects Reviewed starts with
`coding_direct_execution_disabled` before creating a task or contacting GitHub.
The generic extension adapter replaced that fault with `extension_tool_failed`,
leaving Pi without the reason or an actionable approval fallback.

This failure does not establish a checkout or repository permission failure.
Model account authentication and public/private visibility do not change the
repository execution policy.

## Separate installation permission blocker

A scoped Contents-read token successfully read the repository and `main` branch
from the VPS (HTTP 200). The installation granted Contents read, Metadata read and
Issues write, but no Pull requests permission. GitHub rejected the Direct runner's
Contents-read/Pull-requests-read token request with HTTP 422 and a permission
rejection. Publication also requires Contents write and Pull requests write.
The temporary diagnostic token was revoked after the read checks (HTTP 204).

This permission gap was not reached by the failed Telegram starts above, but would
block Direct execution/publication afterward. Map the specific installation-token
permission rejection to `github_app_permissions_missing` instead of
`github_unavailable`. Unknown failures remain sanitized. Installation permission
changes require an operator update in GitHub and were not performed during diagnosis.

## Correction and verification

Expose the start tool only when Direct targets exist, and describe only those
targets. Reviewed proposal guidance explicitly selects the existing approval flow.
Allowlist stable application-owned coding policy faults while keeping arbitrary
exception text and file-extension errors private. Keep the service authorization
checks and Reviewed default intact.

Deterministic regression coverage uses the real Pi extension loader and disposable
PostgreSQL: implicit/explicit Reviewed configurations, mixed target policies,
policy denial with no task creation, reviewed approval fallback, successful Direct
queueing, maintainer denial and sanitized model-visible fault codes. No production
policy change, task replay, GitHub publication or Telegram test send is required.

Validation: `bun run check`, `bun run typecheck` and `bun run build` passed.
The full deterministic suite passed 417 tests across 51 files against disposable
PostgreSQL, with loopback traffic excluded from the host proxy. The GitHub error
tests also verify unrelated HTTP 422 responses remain generic and sanitized.
No deployment or production configuration change was performed.
