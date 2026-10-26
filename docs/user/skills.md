# Skills

Skills are reusable instructions, such as a team recap or issue triage procedure.
They can request existing tools, but cannot grant repository access, install
programs or provide arbitrary shell execution. **Skills** manages instructions;
**Plugins** manages connected services and executable tools.

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
choose **Check for updates** in RepoDesk. Review the saved and incoming instructions
and choose **Apply update**. If the skill has local edits, explicitly confirm their
replacement. Applying an update preserves whether the skill is enabled.

To restore earlier instructions, restore them in GitHub, then review and apply that
source update here. RepoDesk does not offer version selectors or rollback controls
in the panel. Updates are manual; changes in GitHub do not sync automatically.

## Preset and custom skills

**Team recap** and **Follow-up draft** are read-only presets. Inspect their
instructions and enable or disable them. Create a separate custom skill if you
need different rules.

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
Requested tools must already exist in RepoDesk.

GitHub imports include linked `.md` and `.txt` guides inside the skill directory,
including guides referenced by other included guides. Limits are 32 supporting
files, 64 KB per file and 256 KB combined. Missing guides, secrets or oversized
content block import with an explanation. Scripts and archives are not installed
or executed; external links and paths outside the skill directory are not fetched.

Supporting files are saved from the same source commit as the instructions. They
appear in import details, saved previews and update comparisons. The assistant
reads them only through the existing workspace, actor, run and tool permissions.
An imported instruction's credentials or tool declarations never grant access.

## Conversation-created skills

After a useful conversation, ask the bot to preserve the procedure as a team
skill and remove private data. The bot proposes sanitized instructions for you
to review. Your approval shares them with workspace admins as a disabled skill.
Admins can review and edit the instructions, then enable the skill directly.

You cannot create a team skill from another person's private chat. Group sources
remain limited to their topic. Before sharing, check that the proposed instructions
contain no information that should remain private.

Unapproved conversation procedures depend on their retained sources; source removal
or expiry can make them unavailable. An admin save or enable action approves a
standalone procedure with its own lifecycle.

## Changes and availability

Existing runs and schedules keep their saved instruction snapshots when you edit
a skill or apply a GitHub update. New interactive runs use the latest saved
instructions. Disabling a skill can suspend dependent schedules. Archiving a custom
skill preserves historical references and prevents enabling it again.

Use search and the state filter to find a skill. If a save conflicts with another
session, review the latest saved settings before retrying. Failed saves keep your
input in the dialog. Configure missing tools through the relevant
[integration](README.md) before using instructions that require them.
