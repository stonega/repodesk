# Codex reports unavailable GitHub authentication after successful checkout

## Impact and evidence

On 2026-10-23 the user reported a Telegram Codex progress message for
`stonega/street-polls` saying upstream synchronization required unavailable
authentication. Read-only VPS investigation found repeated native Git failures
on 2026-10-22 and 2026-10-23, including `git pull --ff-only` in task
`654cda85-38b8-4efd-84a6-8cc48d54a1fe` at 02:25:24 UTC:

```text
fatal: could not read Username for 'https://github.com': terminal prompts disabled
```

The target repository's `AGENTS.md` instructed the agent to pull upstream changes
before editing. The work container attempted to comply after the application had
already prepared its checkout. The same task subsequently reached a successful
publication phase and the application recorded its review state. The missing
Chromium build dependency mentioned in the screenshot was a separate repository
environment issue.

No account reconnection, token rotation, production configuration change, task
restart, deployment or external message was performed during this investigation.

## Cause

The runner intentionally separates credentials by phase:

- `DevelopmentExecutor.token` mints a repository-scoped installation token.
- `RunnerSupervisor.start` gives that token only to the preparation container.
- `job.clone` authenticates Git using a per-command HTTP header and pins a commit.
- Implementation receives model/channel authentication but no GitHub token.
- Authorized publication receives a fresh GitHub token in another container.

The original coding prompt said to follow repository instructions without
explaining the prepared snapshot or ownership of remote synchronization. Codex
therefore repeated a network pull in an environment deliberately lacking GitHub
credentials. This was a handoff mismatch, not evidence that the connected GitHub
account or App installation had expired.

## Correction and limits

The coding handoff now includes the application-bound repository and pinned base
commit for intake, analysis, work and repairs. It explains the intentional detached
HEAD, preservation of checkpoint/interrupted work, application-owned synchronization
and separate publication authentication. Codex is instructed to use the prepared
snapshot and avoid credential-free remote Git operations or credential requests.

The handoff does not promise that the pinned commit is still the remote head. A
goal explicitly requiring newer history or another remote source must report that
specific application-side requirement. This change does not provide arbitrary
authenticated in-turn fetch/pull, alter token permissions, or refresh an existing
deployed task. The existing credential boundary remains enforced by the runner.

Deterministic regression coverage checks the handoff in each ordinary execution
mode, retained-work guidance, repair-plan preservation and the fallback without
checkout metadata. Live model adherence requires a post-deployment acceptance run.

Validation: Biome, strict TypeScript, production build and all 1,144 deterministic
tests across 126 files passed using an isolated PostgreSQL container. The focused
runner, handoff and Review Bot checks passed all 56 tests. No production rollout
was performed.
