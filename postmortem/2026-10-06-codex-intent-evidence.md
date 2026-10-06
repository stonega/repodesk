# Codex intake returned narrative evidence for a short retry

Date: 2026-10-06. Local correction follows the already-published v0.1.19 release.

## Evidence and impact

A selected `stonega/wallshader` Direct task reached the runner and completed its
intake turn. Codex returned status `intent`, intent `implement` and the correct
input revision. Its evidence field contained 164 characters for a nine-character
current request. The evidence was not a verbatim substring of that input or its
retained reference context. The worker rejected it with
`coding_intent_unverified` before granting implementation or publication.

## Cause and correction

The intake prompt requested a quotation, but the generic response schema accepted
any evidence string and all result statuses. Codex could provide an explanation
that parsed successfully, then failed the worker's source check.

Generate an intake-specific schema using the application's consumed input:
restrict status to `intent`/`needs_input`, evidenceRevision to that revision and
evidence to the exact original text. Pass it through the conversation adapter to
the Codex turn and clarify the prompt's literal-copy requirement. Other modes
keep their existing schemas. Missing current input fails before model dispatch.

The worker's source, actor, tenant, policy and publication checks remain in place.
Do not accept paraphrased or older-context evidence, rewrite a model result into a
grant, automatically resume a stopped task, or move the v0.1.19 tag to this patch.

## Regression coverage

Deterministic tests cover short retries, literal Unicode and quoted text, missing
input revisions, the actual fake app-server turn payload, rejected narrative and
earlier-request evidence, accepted current evidence, and no publication from an
unpublished retry. Live model quality still requires the dedicated pilot journey.

Validation passed: lint, strict typecheck, build and all 420 deterministic tests
against disposable PostgreSQL. The pinned real Codex 0.155.1 protocol proof
confirmed intake constraints at a local fake Responses endpoint. The real Podman
runner smoke passed provider/device execution, checkpoint/reconstruction, repair,
publication fencing, auth recovery, accounting, erasure and cancellation with
fake Codex/GitHub. Job/supervisor images built and Compose configuration validated.
No live model test, GitHub publication, stopped-task replay or deployment of this
patch was performed. The deployed v0.1.19 does not include this correction.
