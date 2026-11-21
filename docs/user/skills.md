# Skills

Skills are reusable instructions, such as a team recap or issue triage procedure.
They can request existing tools, but cannot grant repository access, install
programs or provide arbitrary shell execution. **Skills** manages instructions;
**Plugins** manages connected services and executable tools.

To build a custom executable tool, see [Plugin development](plugin-development.md).

## Manage skills on GitHub

We recommend keeping your skill instructions, reviews and version history in
GitHub. In **Skills**, choose **Import skill**, paste a repository, folder or
`SKILL.md` link, then choose **Find skills**. GitHub is the default import source.
Private repositories require the current workspace's GitHub connection and access.

Select the skills to import. Click a skill's name to inspect its instructions,
source path, metadata, supporting files or any reason it cannot be imported.
Closing the details keeps your selection. Choose **Import skills**, then enable
saved skills when you are ready to use them. There is no separate publish step.

Imported cards include a **Source** link. Make changes in GitHub, then
choose **Check for updates** in Telo. Review the saved and incoming instructions
and choose **Apply update**. If the skill has local edits, explicitly confirm their
replacement. Applying an update preserves whether the skill is enabled.

To restore earlier instructions, restore them in GitHub, then review and apply that
source update here. Telo does not offer version selectors or rollback controls
in the panel. Updates are manual; changes in GitHub do not sync automatically.

## Preset and custom skills

**Team recap**, **Follow-up draft** and **Telegram widgets** are read-only presets. Inspect their
instructions and enable or disable them. Create a separate custom skill if you
need different rules.

The default-enabled [Telegram widgets](widgets.md) preset creates compact local
interactions in private chats and Topics. It cannot grant service access or
authorize external actions.

For a custom skill, choose **New**, describe its purpose and instructions, select
only the necessary tools and configure its output settings. Choose **Save skill**.
The saved instructions are immediately ready to enable. **Edit** opens a dialog;
saving changes to an enabled skill makes them available to future runs.

You can also import a standalone Markdown file. It includes only that file; use
GitHub import when the skill needs supporting guides. GitHub remains the recommended
place to maintain shared instructions and their history.

## Files and access

A `SKILL.md` must be UTF-8 Markdown, at most 16 KB. YAML frontmatter supports
`name`, `description`, `allowed-tools`, `license`, `compatibility` and `metadata`,
including comments, quotes and multiline descriptions. Names allow 64 characters
and descriptions allow 1,024 characters. Metadata values must be strings.
Requested tools must already exist in Telo.

GitHub imports include linked `.md` and `.txt` guides inside the skill directory,
including guides referenced by other included guides. Limits are 32 supporting
files, 64 KB per file and 256 KB combined. Missing guides, secrets or oversized
content block import with an explanation. Scripts and archives are not installed
or executed; external links and paths outside the skill directory are not fetched.

Supporting files are saved from the same source commit as the instructions. They
appear in import details, saved previews and update comparisons. The assistant
reads them only through the existing workspace, actor, run and tool permissions.
An imported instruction's credentials or tool declarations never grant access.

## Global and project-specific skills

Every custom and auto-extracted skill has a **Scope** and **Applies to** setting:

- **Global (all projects):** Reusable across every chat, workflow, and repository
  (for example, weekly recap templates or triage frameworks).
- **Project-specific:** Bound to one connected GitHub repository. Only available
  when working with that repository—in repository-bound groups, chats targeting that
  repository, Codex tasks, and Review Bot runs—and only for members who currently
  have read access to it.
- **Applies to:** Choose whether the skill is used in **Chat & workflows**,
  **Coding & reviews** (injected automatically into Codex and Review Bot cold-start
  context), or **All (chat & coding)**.

In **Skills**, use the scope filter alongside search and state filters to browse
global skills or focus on a specific project repository. You can reclassify a skill
between Global and Project-specific anytime from its **Edit** dialog.

## Autonomous skill extraction

Telo automatically extracts reusable workflows and repository engineering
lessons in the background from completed Codex tasks, multi-step Missions, and
high-signal conversations:

- Auto-extracted skills are classified into **Project** or **Global**, validated
  against secret, prompt-injection, and safe-tool guards, and enabled automatically
  without requiring manual approval steps.
- When follow-up conversations or tasks refine an existing auto-extracted skill,
  Telo updates it in place while preserving snapshots for existing schedules.
  Built-in presets and GitHub-imported skills are never overwritten automatically.
- Cards for auto-extracted skills display an **Auto** badge along with their source
  and usage count. If you disable or archive an auto-extracted skill, Telo
  remembers that choice and avoids recreating the same skill automatically.
- You can also ask the assistant in Telegram to save or update a procedure directly
  (for example, "Save this release checklist for acme/api").

## Changes and availability

Existing runs and schedules keep their saved instruction snapshots when you edit
a skill or apply a GitHub update. New interactive runs load large catalogs
progressively (indexing skill descriptions first and loading full instructions on
demand). Disabling a skill can suspend dependent schedules. Archiving a custom
skill preserves historical references and prevents enabling it again.

Use search, the scope filter and the state filter to find a skill. If a save conflicts with another
session, review the latest saved settings before retrying. Failed saves keep your
input in the dialog. Configure missing tools through the relevant
[integration](README.md) before using instructions that require them.
