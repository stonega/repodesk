# Organization notes with Obsidian

RepoDesk includes an **Obsidian** plugin, enabled by default for existing and new
organizations. Open **Plugins → Obsidian** to manage your organization's vault.
It starts with a home note, meeting and daily templates, an organization Base and
a Canvas. No account, API key, desktop session or additional service is required.

Notes are shared organization knowledge. Every active member can read them from
the bot, including in authorized linked groups. All active members can create and
change notes through interactive bot requests. Scheduled workflows may read notes
but cannot change them. The deployment operator manages the vault in the panel.
Keep personal notes and private conversation history out of the shared vault.

## Work from Telegram

Ask naturally, for example:

- “Find our open launch tasks and the notes that link to the launch plan.”
- “Save an organization note at Projects/Launch.md with these decisions…”
- “Create Meetings/Planning.md from Templates/Meeting.md for 2026-10-22.”
- “Add these updates to the daily note for 2026-10-22.”
- “Rename Projects/Launch.md to Projects/Release.md and update its links.”
- “Move Meetings/Planning.md to Trash.”
- “Restore Meetings/Planning.md from Trash.”

Saving requires your request; note contents do not authorize actions. Conflicting
edits require rereading the latest vault. The bot reports saved paths; it cannot
generate an Obsidian Publish link or claim a desktop synchronization occurred.

## Native note features

Use UTF-8 Markdown files with folders, YAML properties, aliases, nested tags,
headings, tasks and links. Search supports text, paths, aliases, tags, properties,
folders and open/completed tasks. The bot can read outgoing links, backlinks,
unresolved links and note headings. Prefer full vault paths for ambiguous names.

```markdown
---
tags: [project/launch]
aliases: [Release plan]
status: open
owner: Engineering
---
# Launch

Related: [[Decisions/Release#Scope|release scope]]
![[Meetings/Planning#Decisions]]

> [!important] Release gate
> Confirm the rollback plan before shipping.

- [ ] Confirm the owner
- [x] Review the plan
```

Callouts, tables, code, math, Mermaid, block references and embeds remain intact
for Obsidian. RepoDesk displays file source in the panel. Its link index covers
wikilinks, basic Markdown links and Canvas file nodes; links inside code and HTML
comments are ignored. Rename updates resolved links, preserving headings, block
references and display labels. Review unresolved links and references inside Bases
expressions manually. The panel does not render a graphical knowledge graph.

Daily notes use `Daily/YYYY-MM-DD.md` and `Templates/Daily.md`; subsequent updates
append. Template creation accepts `{{title}}`, `{{date}}`, `{{time}}` and date/time
formats using `YYYY`, `MM`, `DD`, `HH` and `mm`. Other Moment or community-template
expressions are unsupported. Ask for explicit dates in your organization's timezone.

Native `.canvas` JSON files and `.base` YAML files can be created, read, edited,
imported and exported. Obsidian renders their maps, database views, formulas and
filters. RepoDesk validates and stores them without evaluating their expressions.
Community plugins such as Dataview and Templater do not run on the server.

## Use the desktop app

1. Choose **Export vault** in the plugin panel.
2. Extract `organization-vault.zip` into a folder.
3. In Obsidian, choose **Open folder as vault** and select that folder.

The export includes core-plugin settings for graph, backlinks, properties, search,
Canvas, Bases, daily notes, templates, outline and bookmarks. Binary attachments
are not stored by this plugin. Features requiring them need local files in Obsidian.
Obsidian Sync and Publish remain your own separately configured services.

To bring desktop edits back, ZIP the files **inside the vault folder**, preserving
their relative paths. Choose **Import**, select the ZIP and review the file count
and skipped files. Select **Replace files with matching paths** deliberately when
updating existing notes. Import merges files atomically and never removes notes
because they are absent from the ZIP. It ignores settings, hidden files, binaries
and executable plugins. Restore a trashed path before replacing it.

Export/import is a snapshot workflow. Desktop edits and RepoDesk edits do not sync
automatically. ZIPs with a wrapper folder import that folder as part of each path.

## Limits and controls

Each organization can retain **500 files**, **100 KB of UTF-8 content per file** and
**5 MB total**, including Trash. Only `.md`, `.canvas` and `.base` files are accepted.
Paths must be relative, without hidden folders, traversal or reserved characters.
Imports check limits before saving; stale revisions and invalid files leave the
vault unchanged. Trash is recoverable and is excluded from normal searches/exports.
Trash has no automatic expiry or permanent-delete control in this release.

The title's **Enable** switch controls bot tools. Disabling preserves notes for
panel management and export. It also prevents pending answers from delivering
notes read under the old enablement; re-enabling does not revive those old grants.
Workspace deletion removes the vault. Notes otherwise remain until explicitly
changed or the workspace is deleted; chat-message retention does not expire them.

See [administration](administration.md) for workspace access controls.
