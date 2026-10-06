# Codex implementation failures hid their underlying reason

Date: 2026-10-06. Observed release: **v0.1.20**.

## Observed behavior

The reported wallshader task passed intake and clarification, then failed in the
implementation phase at 07:53 UTC. The VPS was running v0.1.20 and its release
deployment had succeeded. The final attempt ran for about 50 seconds, below its
configured 2700-second active-time allowance. It reached neither checks nor PR
publication.

The retained task/work volume contained no `failure-code`, conversation result,
thread marker, patch or check diagnostics. Its temporary device-auth volume,
which also held the Codex session, had already been removed. The underlying model,
protocol or completed-result error cannot be recovered from these records.

The task's recorded token total equaled 200000 because unavailable usage consumed
the remaining application reservation. This is not evidence that the provider
reported a 200000-token limit or that time exhaustion caused this failure.

## Cause of the opaque report and correction

The app-server adapter discarded non-authentication error details, and the job
wrote a stage marker only for authentication failures. The supervisor therefore
reported `coding_execution_failed`. Keep raw messages and credentials private,
but preserve an allowlisted error code, validated thread identity and reported
token count before deleting temporary credentials.

The adapter now distinguishes provider quota/rate/network/request errors, context
overflow, sandbox errors, missing final output, invalid JSON and invalid task
results. Telegram and the panel use fixed readable explanations. Work and analysis
output schemas allow only their own result statuses. Official protocol reference:
[Codex app-server errors](https://learn.chatgpt.com/docs/app-server#errors).

The user separately requested removal of application execution-cycle, repair-count,
active-time and token quotas. They are removed from forms, API policies, runner
enforcement and job watchdogs; migration 014 removes saved overrides and rebuilds
reported usage without inventing a quota charge. Provider/account limits and
authorization, cancellation, retention, isolation and publication checks remain.

## Verification boundary

Deterministic fixtures cover failure classification without private data leakage,
large reported usage, quotas absent from old/new settings, repeated repairs beyond
old caps, long-running task recovery, cancellation, tenant-isolated migration and
closed repository dropdowns on desktop/mobile. Local PostgreSQL checks pass.

No stopped production task was replayed, no Telegram message was sent manually,
and no live Codex/model call was made during the initial investigation.

## Authorized VPS reproduction and successful retest

The user subsequently authorized direct VPS code deployment and live testing of
the exact request: "check shaders update for wallshader. if new shaders in paper
shaders, add it". The update was deployed directly as application version 0.1.21,
with a protected pre-migration backup and the existing account credentials intact.
A fresh task was created through the application coding service under the
configured maintainer, with operator-command provenance and normal current-policy,
source, tenant and publication checks. No Telegram update was forged.

The task completed with consumed and verified revision 1. It reported 56631 tokens
for intake and 637719 for implementation: 694350 total, with complete reported
usage. This workload exceeds the old 200000-token task quota. The old conversation
guard would abort it, and its exception would be hidden by the job's generic
failure handling. This establishes a matching failure mechanism; the old turn's
discarded error itself remains unavailable.

Codex found that Wallshader already includes every shader in the latest published
Paper release it checked, 0.0.81. It updated the review record in
`docs/implementation/update-paper-shaders.md`. Build, lint, all 49 repository tests
and patch-integrity checks passed. Native checks were not run because only
documentation changed and GJS is unavailable on the execution image.

The verified 1274-byte patch is retained for review. The repository's publication
default is disabled, so no GitHub PR or repository write was made. The application
released the runner slot after completion; its task is in review, while the local
container record is cancelled as resource cleanup rather than a task failure.
