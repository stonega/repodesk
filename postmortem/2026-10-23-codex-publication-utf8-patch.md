# Codex documentation publication stopped by corrupted UTF-8 output

Incident and investigation: 2026-10-23. Status: **diagnosed on the VPS; decoder
correction implemented locally; deployment and historical task recovery pending**.

## Impact

Task `f1a62855-c296-42cf-982d-a1d2d4bcbc3e`, “sync repodesk-landing docs again,”
ended with `unknown` / `coding_publication_unknown` on VPS v0.1.43. The panel displayed
“Outcome uncertain” and asked an administrator to inspect GitHub.

Implementation and independent repository verification completed successfully.
Publication then failed while applying the exported patch to its fresh checkout,
before committing, pushing or creating a PR. The verified work remains retained
in the task's work volume. GitHub inspection found no matching task branch or PR.

## Evidence and timeline

All times below are UTC on 2026-10-23; Taipei time is UTC+8.

| Time | Observation |
| --- | --- |
| 03:51:50 | Application task created. |
| 03:53:38 | Work implementation container started. |
| 04:01:34 | Implementation exited successfully. |
| 04:01:42–04:04:43 | Independent verification ran and exited successfully. |
| 04:04:59 | Publication container started. |
| 04:05:02 | Publication exited with code 1, without an OOM. |
| 04:05:11 | Application saved the terminal unknown publication outcome. |

The work attempt is `aef3d7b2-d56a-4135-9725-c19854d8840a`; its Docker resource
prefix is `deepx-codex-d8a32cc17bd8092b525b76161d214fdd`. Both the work and
publication checkouts have base commit
`14de6b38800a205c78edcec69b50a598c2f432c6`. The publication checkout is clean:
there is no staged diff, publication intent or publication result.

The retained patch is 70,032 bytes and contains nine Unicode replacement
characters. Regenerating the same staged binary diff directly from Git produces
70,017 bytes and no replacement characters. The retained work result and the
runner's exported patch have identical hashes, placing the corruption before
runner export rather than in the publication transport.

A read-only `git apply --check --index` on the publication checkout rejects the
retained patch in `docs/user/cloudflare.md` and `docs/user/groups.md`. Passing
the regenerated raw patch to the same check succeeds. The changed bytes lie at
4,096-byte output boundaries. These observations establish an output decoding
error rather than a base-branch conflict or failed GitHub authentication.

Evidence came from task-scoped application/attempt records, retained runner
state and patch artifacts, container state, read-only Git operations and GitHub
branch/PR lookups. Task containers disable Docker logging, so publication logs
are unavailable. No credentials or unrelated messages were collected.

## Cause

The job command helper accumulated subprocess output with
`output += chunk.toString()`. A pipe can split a Chinese character's UTF-8 bytes
across chunks. Decoding each buffer separately replaces these fragments with
replacement characters, corrupting both patch context and added text. The stderr
collector used the same pattern.

Repository checks run against the intact worktree. `git diff --check` validates
whitespace there; it does not round-trip the exported patch through a fresh
checkout. Checks therefore passed even though the decoded patch could not be
applied. Publication classifies nonzero exits conservatively as unknown, and
without a publication intent SHA there is no remote result to reconcile.

## Correction and recovery boundaries

The job command helper now sets UTF-8 encoding on each output stream before
collecting data. Node preserves incomplete multibyte sequences until subsequent
bytes arrive. The helper is extracted into `job-command.ts` for deterministic
regression coverage; each production caller still supplies its explicit,
restricted command environment. Existing output limits and failure handling
remain in place.

Regression coverage forces one-byte stream fragments, preserves Chinese, emoji
and accented text, applies the resulting Git patch to a separate index/worktree,
checks Unicode failure diagnostics and line callbacks, and runs a real subprocess
with explicit environment and stdin. Restoring the old decoder makes the patch
and diagnostic regressions fail.

The fix prevents future output corruption; it does not rewrite or resume an
existing terminal task. Recovery must preserve the original work, regenerate the
patch from that verified index, revalidate current authority and remote state,
and use the application's publication boundary. This investigation did not change
production state, replay publication, create a PR, send Telegram messages or
deploy a release.

Local validation passed Biome, strict TypeScript, the production build, the Node
runtime contract and all 1,163 deterministic tests across 127 files against an
isolated PostgreSQL container. No dependency or migration was added.
