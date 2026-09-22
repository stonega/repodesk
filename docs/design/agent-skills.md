# Agent skills managed in the web panel

Status: **P0 design contract with local implementation**. Admins manage Markdown
skills, versions and settings through the web panel. The Test control validates policy
and previews context without paid calls. See [implementation evidence](../implementation/implementation-status.md).

Executable **plugins** are [Pi extensions](llm-extensions.md), a separate capability
from instruction skills. Operators install reviewed extension tools and hooks and
manage their registry through **Workspace → Plugins**.

## Pi integration boundary

Pi's coding-agent documentation describes skills as `SKILL.md` packages with metadata,
instructions and optional supporting files, loaded on demand. The format includes
names/descriptions and optional tool metadata. This describes the coding-agent harness;
our use of bare `pi-agent-core` needs an application-managed skill catalog and loader.
[Pi skill documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)

Use a compatible Markdown instruction format where practical, but define execution
policy in application records. Do not discover skills from the host user's home,
automatically install npm packages, or grant shell access from imported instructions.
The skill manager configures instructions and already-registered tools in P0.

## Skills screen

| Control | P0 behavior |
| --- | --- |
| Catalog | Search/filter installed and curated skills by name, enabled state and scope; show purpose, version and required tools. |
| Create/import | Create an instruction skill in an editor or import a single `SKILL.md`; validate metadata, size and tool references. |
| Detail/editor | Edit name, description, instructions and schema-defined settings; preview the model-visible content. |
| Enable/disable | Enable approved published versions per workspace and optionally narrow availability per group/workflow. |
| Tool permissions | Show required tools and effective allowed subset; unavailable tools block activation or require an explicit reduced capability variant. |
| Settings | Configure skill-specific values such as recap sections, date window and response length; secrets remain credential references. |
| Test | Run a draft with explicit sample input, fake/read-only tools and displayed usage limits; no message publishing or schedule activation. |
| Publish/version | Save drafts, inspect a diff, publish immutable versions and select a prior version for rollback. |
| Usage | Show authorized runs/workflows using the skill and pinned version; respect run-level visibility. |
| Archive | Stop new assignment while retaining referenced versions for history; show affected workflows before removal. |

The implemented catalog groups management icons beside the title, separates the
description from revision metadata, and places Publish draft and Test draft policy
below the instruction preview. Restore a published version expands a version
selector and rollback action; the selected source is independent for each card.
Skills without published versions do not show restore controls.

Starter catalog: team recap, decision/blocker summary and follow-up drafting. These
are reusable instructions over available chat context, not new autonomous write tools.
Workspace admins can manage their catalog; only deployment operators register new
executable tool implementations. Restrict edits to built-ins by offering a workspace
copy so upgrades do not overwrite local customizations.

## Records and state

| Record | Fields |
| --- | --- |
| Skill | ID, workspace/curated scope, stable slug, display name, description, owner, archived state |
| SkillVersion | Immutable version, instruction body, validated metadata/settings schema, declared tools, checksum, author, created/published times |
| SkillAssignment | Workspace/group/workflow scope, pinned version, enabled state, validated settings, grant ceiling, revision |
| SkillTest | Draft version/hash, input references, result, usage, timestamp, authorized actor |

Editing creates a draft. Publishing does not automatically update every pinned
workflow. Show an explicit upgrade action and affected schedules. Invalid drafts
may be saved but cannot be enabled. Duplicate slugs in the same scope require an
explicit rename; no silent first-file-wins behavior.

## Runtime contract

At run creation resolve enabled assignments, exact versions and settings. Persist
that snapshot on the run. Include relevant names/descriptions in context; a bounded
`load_skill` tool retrieves only authorized pinned content when needed. An explicitly
chosen workflow skill loads deterministically. Skill selection cannot change tenant,
actor, destination, approval requirements or the underlying tool registry.

Effective tool access is the intersection of deployment-approved tools, workspace
policy, actor permissions, connection grants, workflow policy and skill assignment.
Imported `allowed-tools` metadata is a requested capability list, never a grant.
User input and skill instructions cannot override these checks.

Changing instructions affects future runs only. Disabling a skill is an immediate
policy restriction: prevent new loads/steps and suspend dependent scheduled work,
reporting why. Do not silently substitute another skill. In-flight calls may finish;
check current restrictions before subsequent tools and delivery.

P0 imports one Markdown file and rejects executable/archive payloads. Supporting
reference bundles and reviewed scripted skills are later additions requiring storage,
path validation and isolated execution. No arbitrary URL-fetch/install operation is
implicit in “import skill.”

## APIs and acceptance

Add workspace-scoped `/api/admin/workspaces/:id/skills` resources for list/create,
versions, draft validation, test, publish, assignments and archive. Require expected
revision on edits, server-side role checks and redacted audit events.

Tests cover malformed metadata, duplicate names, cross-tenant reads, imports requesting
unavailable tools, secret leakage, stale edits, version pinning and rollback. Browser
tests create a recap skill, test it, publish/enable it, observe its version in a bot
run, then disable it and confirm a dependent schedule cannot execute.

The loader must also pass prompt-injection and no-write tests: a skill asking to
change the whitelist, send an external message or activate a workflow cannot acquire
those powers merely by describing them in Markdown.
