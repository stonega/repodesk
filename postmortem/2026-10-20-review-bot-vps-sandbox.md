# Review Bot cannot start its command sandbox on the VPS

Investigated on 2026-10-20 using the operator-authorized VPS connection. No
deployment, configuration change, task replay, model call or external message
was performed. Credential-free diagnostic containers were removed after use.

## Confirmed impact

The workspace retained three automatic review tasks, all terminal and cancelled.
None recorded a published review ID. The two tasks for `stonega/wallshader` PR #2
completed their model turns with `needs_input` before later cancellation:

| Task | Created (UTC) | Requested head | Reported tokens |
| --- | --- | --- | --- |
| `39550da8-fdb9-4769-94e7-9adf451585cb` | 2026-10-20 05:12:29 | `dfabab0af85ceea813f9c44a4f1b6498745bf83c` | 43,652 |
| `d5fe7707-6394-4b7d-80f6-11c6da8f5644` | 2026-10-20 05:20:46 | `b32536d0e607a3cdbb340ca22c57db172233f99f` | 29,577 |

Both results report that reading `/task/open-code-review.json` failed before
command execution. Neither inspected the OCR plan, rules, diffs or source files;
both assessed zero files and returned no findings. They asked for sandbox access
to be restored. The saved result of the second attempt and a fresh
credential-free probe identify the native error:

```text
bwrap: No permissions to create a new namespace
```

The third task, for `stonega/street-polls` PR #8 on 2026-10-19, was cancelled
without a saved model result. This investigation does not attribute that task to
the sandbox failure or establish why each cancellation was requested.

## Runner evidence

App, worker, supervisor, PostgreSQL and Code Truth were healthy. Root storage was
50% used. The running application reported version 0.1.42. Healthy service probes
therefore did not establish successful review command execution.

The current supervisor selected task image
`sha256:b70c14aea441d70515a65d1d56fc93e93b024c1dad7635667290b7b8d7259d68`.
Two fresh containers used that exact image, UID/GID 1000, read-only root,
dropped capabilities, no-new-privileges, temporary task/tmp filesystems and no
network, credentials or production volumes. They attempted `/bin/true` through
the pinned Codex CLI:

- The review split filesystem policy exited 1 with the same bubblewrap namespace
  error. It denied `/auth`, `/task/codex`, `/task/home/.codex` and `/proc`.
- Ordinary read-only mode with `features.use_legacy_landlock=true` exited 0.
  This only checks command startup, not every filesystem or network boundary.

The host was Ubuntu 24.04.5 with kernel 6.8.0-147-generic. Its
`kernel.unprivileged_userns_clone` was already 1 and `user.max_user_namespaces`
was 31611; AppArmor's unprivileged-user-namespace restriction was enabled.
Docker reported default AppArmor and seccomp policies. The generic error's
suggestion to enable `unprivileged_userns_clone` does not describe this host's
current setting. No specific AppArmor/seccomp rule was isolated or changed.

## Cause

`runConversation` deliberately gives read-only Review Bot work a split policy
that denies credential paths and process metadata, with a clean shell
environment. The pinned CLI requires bubblewrap for these denied subpaths.
The [ordinary intake correction](2026-10-19-codex-intake-sandbox-startup.md)
explicitly preserved this review policy, so it did not fix reviews. The current
VPS image still cannot start that sandbox under the tested container restrictions.

A successful native/model turn and runner `succeeded` state can hold an application
result of `needs_input`. `ReviewExecutor.poll` turns that result into `waiting`;
it does not establish successful review coverage. Infrastructure failure is thus
presented as a question rather than a specific terminal sandbox error.

## Correction

Read-only review/answer investigation now uses the application-owned
`repodesk_review_source` dynamic tool. It offers only paginated OCR plans,
committed file lists/blobs and literal-path merge-base diffs for the task's pinned
commits. It cannot accept arbitrary commands, repository locations, runtime file
paths or arbitrary revisions. Source reads never follow working-tree symlinks.
Fixed Git subprocesses receive a clean environment and disable external diff,
textconv, hooks, fsmonitor and replacement objects. Reads have time/size bounds
and return explicit failures without raw errors or credentials.

Native shell, image-viewer and subagent tools are disabled for these sessions.
The existing split filesystem policy, no-new-privileges, dropped capabilities
and read-only container root remain. Project trust configuration is placed at
the correct config level. Investigation no longer needs a nested bubblewrap
namespace or a relaxed host/container security policy. The application validates
the OCR plan, complete rule coverage and actual merge base before a model turn;
preparation failure stops the task with `coding_review_preparation_failed` rather
than asking a user to restore shell access. Ordinary coding/fix execution retains
its existing path.

The Docker lifecycle smoke now includes a real Node 24, pinned Codex app-server
and real OCR proof with a local fake Responses provider. It verifies new/resumed
sessions, working source/plan/diff/list reads, exclusion of native shell tools and
rejection of runtime credential/process paths. The same bundled correction passed
on the VPS in a disposable container using its deployed task image, with no
network, credentials or production volumes. This proves the host integration
path, not live model review quality or a production rollout.

Validation passed lint, strict TypeScript, production build, 1,060 deterministic
tests across 119 files with disposable PostgreSQL, app/task/supervisor Docker
builds, packaged Node runtime checks, Compose validation and the complete Docker
lifecycle smoke. Focused regressions cover immutable commits, denied runtime
paths and symlink targets, pagination, malformed/stale plans, external Git drivers
and terminal preparation failures without publication. No dependency or migration
was added.

An authorized release must update the task image before new production reviews
use the correction. Retry only the current PR head afterward; historical cancelled
tasks remain untouched. No live review, GitHub publication or production service
replacement was performed during these checks.

References: [pinned Codex 0.155.1 sandbox behavior](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/linux-sandbox/README.md)
and [official container sandbox guidance](https://learn.chatgpt.com/docs/agent-approvals-security).
