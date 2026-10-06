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
and no live Codex/model call was made during investigation. A new authenticated
live request after rollout is needed to identify the remaining execution cause
or establish that implementation completes. Do not describe the old failure as
fixed solely because deterministic tests pass.
