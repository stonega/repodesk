# Managed Obsidian organization vault

Implemented 2026-10-22. Each workspace has an independent application-managed vault
stored in its existing JSONB aggregate (`Workspace.obsidian`). The optional plugin
setting defaults to enabled when absent. Existing and newly created workspaces
therefore receive the same starter vault lazily, without a data migration or local
filesystem mounts. Defaults are deterministic; the first mutation materializes them.

`src/obsidian/` separates schemas, native-format indexing/validation, archive export,
bounded browser import, tenant services and the trusted Pi extension. The bundled
`repodesk-obsidian` skill describes tool use and sharing boundaries. `fflate` is the
single added dependency, providing portable ZIP export and bounded browser-side
extraction without shell commands, temporary server files or a desktop API.

## Contracts

- `obsidian_query`: paginated text/path/alias, tag, property, folder and task filters;
  summaries include properties, headings, tasks, links, backlinks and unresolved links.
- `obsidian_read`: native UTF-8 file source plus the vault revision and summary.
- `obsidian_write`: save, rename with resolved-link updates, recoverable trash/restore,
  template creation and daily-note creation/append. All writes require a current
  vault revision. The application writes only internal organization records.
- Panel APIs under `/api/admin/workspaces/:id/plugins/obsidian`: GET overview/search,
  PUT enablement, GET `/file?path=…`, POST `/files`, GET `/export` as an uncached ZIP.
  `/files` also supports an atomic merge import with explicit `overwrite` opt-in.

Panel requests require the workspace's deployment operator and existing session,
Origin and CSRF checks. Bot calls bind workspace, persisted run, actor, plugin
generation and execution fence. All active members can read shared notes and
write in interactive runs. Current membership, cancellation, workspace pause,
destination and deletion are checked under the workspace lock. Scheduled writes
are denied. The extension adapter retains its existing `read-only` execution mode;
trusted application services own these internal mutations, with no shell or
external Obsidian write capability.

Mutations clone the vault before validation and persist atomically through
`Store.change`. Run/call receipts deduplicate repeated appends across workers;
stale revisions fail closed if an old receipt has aged out. Receipts retain only
hashes and result identifiers, not a second content copy. Audits record the action
and vault revision without titles/content. Deletion purges the vault with the
workspace. Disable/re-enable advances a generation pinned on reading runs;
`runAllowed` rejects old retained evidence and pending delivery.

## Native format support and boundaries

Markdown is preserved verbatim. YAML frontmatter is parsed with bounded aliases;
invalid YAML and duplicate keys fail validation. The link index covers wikilinks,
basic Markdown links and Canvas file nodes, excluding fenced/inline code and HTML
comments. Ambiguous short links remain unresolved. Rename updates resolved note
and Canvas file-node references; Bases expressions and unresolved references remain
manual review. No expression, raw HTML or community plugin is executed.

Canvas validates node IDs/types/coordinates, file paths and edge references. Bases
requires YAML with named typed views while preserving extensible view/formula data.
Export writes native files and application-owned `.obsidian` core-plugin settings.
Import is UTF-8 text only and skips settings/plugins/binaries; it does not delete
missing files. The managed vault has no background desktop sync, Obsidian Sync,
Publish, binary attachments or graphical rendering in RepoDesk.

The aggregate remains capped at 500 files, 100 KB per file and 5 MB total including
Trash. Search defaults to 25 results with at most 50 per page. This is a small-team
pilot; increasing limits requires dedicated indexed tenant storage. The user guide
is [Organization notes with Obsidian](../user/obsidian.md); runnable requests are in
[obsidian.http](../../examples/obsidian.http).

Native formats follow [Obsidian's official help](https://help.obsidian.md/),
[Bases syntax](https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Bases%20syntax.md)
and [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/). Exported desktop rendering
and native Telegram/model acceptance require a live staging check; local browser
coverage verifies the admin panel without a desktop Obsidian session.
