# Repository investigations and releases

RepoDesk can keep an investigation, code change or GitHub release in one durable
task. Pi handles the conversation and passes your original request to Codex.
Codex reads the checkout, repository instructions and release procedure. RepoDesk
checks access and performs supported GitHub writes.

## Default availability and overrides

Complete [Codex setup](codex.md) and [GitHub connection](github.md). Investigation
and release tasks are then available by default for selected repositories; no
separate activation command is needed. Existing workspaces with missing settings
use the same defaults. Explicit saved disable settings remain effective.

A workspace owner/admin can override a repository's defaults, for example:

```text
Configure repository tasks: example/project investigation=true release=false
```

Both values must be present. Set either to `false` to disable that objective or
`true` to restore it. Every task still needs a current request and verified
repository access. Upgrade the application and Codex supervisor together before
using these objectives. An older supervisor cannot execute the new objectives.

## Investigate or release

For example:

```text
Use Codex to investigate example/project's startup failure. Explain your findings.
Prepare release example/project v1.2.0 following docs/release.md
Release example/project v1.2.0 following docs/release.md
```

An investigation stays read-only. Preparing a release verifies its documents,
notes and any supported assets, and reports preparation without publishing.
The direct release request authorizes supported GitHub publication for that
version. Specify the version explicitly; mention `draft` if you want a draft.
Repository instructions and remembered preferences cannot provide publication
permission.

Codex can prepare changes and a review PR when the procedure requires them.
RepoDesk waits for that exact PR to merge, then prepares again from the current
default branch before publishing. PR merging keeps its existing confirmation
flow. If the guide requires CI, the task waits for checks at the exact target
commit. No Codex process needs to remain running while it waits. Failed CI can
return the same goal to Codex for repair.

Supported publication consists of a version tag, GitHub Release and up to eight
assets totaling 1 MiB. Procedures are bounded repository files. Registry
publication, deployments and arbitrary external commands are not release
adapters; a required unsupported step blocks release completion. A procedure
that needs GitHub checks/statuses also requires read permissions for those APIs
on your GitHub App. An administrator must update and approve those permissions.

## Continue and recover

Reply with a correction, missing product decision or an explicit new objective.
The original inputs and task ID remain available. A new objective receives a
fresh interpretation before execution. Ask for status to distinguish prepared,
waiting for merge/CI, published, blocked and uncertain outcomes. A draft is
reported as a draft.

Stopping or losing access prevents future actions. Already confirmed tags,
Releases and assets remain on GitHub. After a lost write response, RepoDesk reads
the target to confirm what happened. If the outcome cannot be established, it
leaves the task uncertain instead of repeating the write. Ask an administrator
to inspect that target before starting another release for the same version.

Task identity survives worker and Codex process restarts. Retained checkpoints
may resume; otherwise the next execution reconstructs from current repository
state, authenticated inputs and valid references. See
[memory and privacy](memory-and-privacy.md) for source retention and forgetting.
