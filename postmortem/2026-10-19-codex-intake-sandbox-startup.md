# Codex intake cannot read source inside the hardened task container

Investigated locally on 2026-10-19 after an operator supplied a Telegram screenshot.
No deployment, task replay, Telegram send or GitHub mutation was performed.

## Observations and limits

The original request names the componenthunt project and asks to reposition its
Back to discovery button. The first assistant response reports two rejected
repository-target checks and no created task. A retry reaches Codex, whose visible
result says repository inspection is blocked by sandbox startup and no files changed.

The public admin page serves v0.1.41 and its readiness endpoint responds with HTTP
200. SSH to the documented VPS address timed out during this investigation; the
admin browser has no authenticated session. The screenshot contains no task ID.
The exact live tool arguments, native command failure and task state therefore
remain unverified. A healthy application endpoint does not verify task isolation.

## Local reproduction

The shipped task image contains Codex CLI 0.155.1. Running its default sandbox as
UID 1000 with a read-only container filesystem, dropped capabilities and
no-new-privileges fails before a source command runs:

```text
bwrap: No permissions to create a new namespace
```

Intake and factual analysis explicitly use `read-only`, overriding the generated
configuration's work-mode sandbox selection. They therefore invoke bubblewrap
even though work turns rely on outer container isolation. Existing protocol and
lifecycle fixtures returned model results without executing a real sandboxed shell
command, so they did not detect this incompatibility.

With `features.use_legacy_landlock=true`, the same image and Docker restrictions
allow reading source, deny writes to the repository and temporary/task directories,
and deny network socket creation. This reproduces a concrete failure consistent
with the screenshot; it does not prove the unavailable live attempt had that exact
native error.

Repository-target validation independently accepts `componenthunt` for the source
request and rejects a model-expanded `stonega/componenthunt` quote. This is one
possible explanation for the earlier rejection, not a confirmed live root cause.
The target guard remains enforced; the tool and built-in skill now explicitly
explain short quotes and distinguish target validation from GitHub availability.

## Correction

Ordinary new/resumed sessions select the pinned CLI's legacy-compatible Landlock
backend. Intake, analysis and result-only correction preserve their read-only and
network boundaries. Work turns retain their existing container isolation.
Credential-denying PR review policies keep their split filesystem policy and do
not receive the legacy override; unsupported review sandboxes still fail closed.

The Docker lifecycle smoke now starts with a real, credential-free Codex sandbox
probe before installing its fake executable. Deterministic protocol tests cover
new/resumed ordinary sessions and unchanged credential-denying review policies.
There is no dependency, schema, environment-variable or Docker privilege change.

Validation passed Biome, strict TypeScript, production build and 948 deterministic
tests across 106 files with disposable PostgreSQL. Matching app, supervisor and
task images built; the Node 24 runtime contract, Compose validation, full Docker
lifecycle smoke and the pinned CLI's local fake-provider protocol proof passed.
The protocol proof accepts the updated session configuration and covers structured
results, continuation, corrections, authentication errors and cancellation; the
separate real sandbox probe exercises command enforcement without a model.

Apply the task-image change through the normal authorized release workflow.
Inspect the original task and any retained result before continuing it; no
historical attempt is automatically replayed by this change.

References: [official Linux sandbox behavior](https://learn.chatgpt.com/docs/agent-approvals-security#os-level-sandbox)
and [the pinned CLI's sandbox implementation](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/linux-sandbox/README.md).
