# Agent skills managed in the web panel

Status: **P0 design contract with local implementation**. Admins manage Markdown
skills, versions and settings through the web panel. The Test control validates policy
and previews context without paid calls. See [implementation evidence](../implementation/implementation-status.md).

Executable **plugins** are [Pi extensions](llm-extensions.md), a separate capability
from instruction skills. Operators install reviewed extension tools and hooks and
manage their registry through **Workspace → Plugins**.

## Conversation-created drafts (2026-10-07)

Users can ask to preserve a successful assistant procedure as a reusable skill.
The bot reads a retained successful run owned by that actor, proposes sanitized
inputs/steps/output conventions and an example, and shows the complete draft for
approval. Approval shares it with admins as a disabled, unpublished catalog entry.
Current admin controls handle editing, publication and enablement. Source run,
actor, sharing time and source hashes are retained as provenance.

Private inputs cannot be selected from another person's chat or imported into a
group. Group sources stay in their topic. Source changes/removal block pending
proposals and unpublished drafts, and cleanup removes derived draft content.
Admin publication approves a standalone procedure with its own lifecycle, like
other approved instructions; it survives source expiry until edited/archived.
Workspace deletion removes it. Tool requests never carry the original user's
credentials or repository grants. Existing schedules retain their pinned versions.
See [implementation plan](../implementation/team-workflows-plan.md) and
[examples](../../examples/team-workflows.md).

## Pi integration boundary

GitHub is the core workflow. Connected workspaces automatically load the bundled
[`repodesk-github` skill](../../skills/repodesk-github/SKILL.md) and app-owned repository
lookup, metadata reads, issue proposals and PR merge/close proposals. This applies
to existing workspaces without a custom plugin manifest or catalog migration.
The skill is appended to the ordinary agent system instructions on every interactive
run, alongside registered tools; it never grants permissions. Optional Code Truth
and Codex execution still require their own configuration. Custom workspace skill
drafts, publication, enablement and pinned versions remain independently managed.
Internal compaction/follow-up classification does not load extension tools or skills.

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
| Catalog | Search/filter skills by name and enabled state; show purpose, required tools and a Preset badge for built-ins. Custom skills also show version metadata. |
| Create/import | Create an instruction skill, import a Markdown file, or discover and select multiple `SKILL.md` packages from a GitHub repository/folder link, including connected private repositories and linked Markdown/text guides; validate metadata, size and tool references. |
| Detail/editor | Preview every skill's instructions. Edit name, description, instructions and settings for custom skills; presets are read-only. |
| Enable/disable | Enable approved published versions per workspace and optionally narrow availability per group/workflow. |
| Tool permissions | Show required tools and effective allowed subset; unavailable tools block activation or require an explicit reduced capability variant. |
| Settings | Configure skill-specific values such as recap sections, date window and response length; secrets remain credential references. |
| Test | Test custom drafts with explicit sample input and fake/read-only tools; no message publishing or schedule activation. |
| Publish/version | Custom skills save drafts, publish immutable versions and select a prior version for rollback. Presets expose no version management. |
| Usage | Show authorized runs/workflows using the skill and pinned version; respect run-level visibility. |
| Archive | Archive custom skills while retaining referenced versions for history. Presets use enable/disable only. |

Preset **Team recap** and **Follow-up draft** cards show a Preset badge, saved
instructions and one enable/disable action. They expose no editor, publication,
policy test, archive, revision counts or rollback controls. The server enforces
the same restriction. The policy sample form is hidden when the catalog page
contains only presets. Custom and GitHub-imported skills retain their management
controls.

Expanded previews show settings in a compact responsive grid and required tools
as wrapping tags. Instructions remain complete, and an empty dependency list uses
a short “No dependent workflows” message. The same preview serves preset and
custom cards; management actions stay at the top right when the header wraps.

New starter records carry an application-owned preset marker. Existing unchanged
seed records are recognized by their original position and complete instruction,
metadata, settings and tool definitions, including the older tool-list variant.
Previously customized or archived seeds retain custom management; source-imported
and conversation-created skills remain custom. A successful toggle persists the
legacy marker. No content or tool grants are changed during recognition.
Internal revisions and published snapshots remain for stale-write protection,
run history and workflow pins; presets cannot append or restore versions through
admin management. See [preset API examples](../../examples/preset-skills.http).

The implemented custom catalog groups management icons beside the title, separates the
description from revision metadata, and places Publish draft and Test draft policy
below the instruction preview. Restore a published version expands a version
selector and rollback action; the selected source is independent for each card.
Skills without published versions do not show restore controls.

Enable stays disabled until a version is published, with guidance to review the
instructions and choose Publish draft. Publication and enablement remain separate
actions. Archived cards show an Archived badge and explain that their instructions
can be reused in a new skill; Enable and Archive are unavailable. Management icons
stay together when the header wraps, and request errors appear below the header
without displacing individual buttons. A rejected enable request explains the
published/unarchived requirement instead of exposing `publish_first`.

The catalog has a right-aligned search and state toolbar with accessible names in
place of visible field labels. Search ignores case and repeated whitespace, and
matches all entered words across names, slugs and descriptions. Search and the
enabled/disabled filter combine on the current catalog page; pagination is unchanged.
The toolbar shows the matching count, offers a clear-search action, and wraps on
mobile. No-match results offer Reset filters; an empty catalog offers creation guidance.

Starter catalog: team recap, decision/blocker summary and follow-up drafting. These
are reusable instructions over available chat context, not new autonomous write tools.
Workspace admins can manage their catalog; only deployment operators register new
executable tool implementations. Built-in preset definitions are read-only;
admins create separate custom instructions when they need a different procedure.

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
Workflows may omit a skill entirely and run their free-form task without any skill
pin or skill availability dependency. Approved run context and scoped model-cost
reads remain available, as do application/extension tools with independent grants;
omitting a skill grants no additional connector or write authority.

Effective tool access is the intersection of deployment-approved tools, workspace
policy, actor permissions, connection grants, workflow policy and skill assignment.
Imported `allowed-tools` metadata is a requested capability list, never a grant.
User input and skill instructions cannot override these checks.

Changing instructions affects future runs only. Disabling a skill is an immediate
policy restriction: prevent new loads/steps and suspend dependent scheduled work,
reporting why. Do not silently substitute another skill. In-flight calls may finish;
check current restrictions before subsequent tools and delivery.

Imports accept one Markdown file or an HTTPS `github.com` repository, folder
(`tree`) or `SKILL.md` (`blob`) link. GitHub discovery lists every matching file
under that scope, including invalid files. Discovery rows show only a selection
checkbox and skill name; selecting the name opens a read-only dialog with the
description, source path, instructions, supporting files and any unavailable
reason. Files without readable name metadata use their containing folder name
or `SKILL.md` at the repository root. Closing details restores focus and keeps
the selection. Pending imports lock selection and details. Users explicitly select
the drafts to import; duplicate slugs fail atomically. A direct file link selects
only that file. Branch names containing slashes are resolved against GitHub.

Public sources are read without credentials. Private sources must be selected in
the workspace's GitHub connection and use the operator's existing GitHub App,
with a short-lived token restricted to that repository and Contents-read. No PAT
is accepted. Connection and admin authority are rechecked after reads and before
saving; removing a connected source blocks further updates without deleting its
approved instructions.

Each imported skill records repository, tracked branch/tag/ref, file path, commit,
blob SHA and imported draft hash. **Check for updates** opens a review dialog and
compares that file and its bundled guides with the tracked ref. **Save update draft** imports changed
instructions without publishing, enabling or changing scheduled version pins.
Local draft edits require an explicit replacement checkbox. The server rechecks
the skill revision and previewed source commit; a changed repository requires a
fresh preview. Removed files and upstream failures retain the saved skill.
Updates are initiated in the panel; automatic publication or background syncing
is not implemented. Commit links remain pinned to that commit.

Imports accept UTF-8 `SKILL.md` files up to 16 KB with YAML frontmatter. Supported
fields are `name`, `description`, `allowed-tools`, `license`, `compatibility` and
`metadata` (string values). Names allow up to 64 characters and descriptions up to
1,024 characters, preserved without truncation. Quoted and multiline scalars,
comments, and string/list tool declarations are supported. Duplicate fields,
aliases, custom tags, unknown fields and unregistered tool names fail explicitly.
The explicit `yaml` dependency supplies YAML 1.2 parsing instead of the old
line-based parser. Source metadata is retained as reference data, never authority.
When tools are omitted, defaults include context/instruction reads and `load_skill`.

GitHub imports recursively include linked `.md`/`.txt` guides inside the skill's
own directory from the same commit: at most 32 files, 64 KB each and 256 KB total.
Reference-style links, fragments and cycles are supported. Missing local guides,
symlinks, links into another skill package, oversized content, secrets or binary
text make that candidate unavailable with a reason. External links, paths outside
the skill directory and non-text links are not fetched. Scripts and archives are
not executed or installed. A standalone Markdown upload includes only that file;
use GitHub import to include supporting guides.

Guides and source metadata are visible in import review, saved instruction previews
and source-update comparisons. They are saved in immutable published versions.
`load_skill` accepts an optional exact resource `path` and checks the existing
workspace, actor, enabled-skill, run and version-pin boundaries. A content hash
detects guide-only updates; they still require draft review and publication, and
cannot rewrite existing run or schedule pins. Discovery caps at 100 skills and
rejects truncated or oversized GitHub trees rather than showing partial results.
Only fixed GitHub API endpoints are fetched.

## APIs and acceptance

Add workspace-scoped `/api/admin/workspaces/:id/skills` resources for list/create,
versions, draft validation, test, publish, assignments and archive. Require expected
revision on edits, server-side role checks and redacted audit events.

Tests cover malformed metadata, duplicate names, cross-tenant reads, imports requesting
unavailable tools, secret leakage, stale edits, version pinning and rollback. Browser
tests create a recap skill, test it, publish/enable it, observe its version in a bot
run, then disable it and confirm a dependent schedule cannot execute.

The loader must also pass prompt-injection and no-write tests: a skill asking to
change membership, send an external message or activate a workflow cannot acquire
those powers merely by describing them in Markdown.

The `/admin/skills` heading places Import before New (user preference, 2026-10-06).
