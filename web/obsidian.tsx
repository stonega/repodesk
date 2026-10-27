import { useCallback, useEffect, useRef, useState } from "react";
import type { ObsidianPage, VaultFile } from "../src/obsidian/config.ts";
import { importArchive } from "../src/obsidian/import.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { PluginDetailHeading, PluginToggle } from "./plugin-detail.tsx";
import { SkeletonRows } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type FileView = VaultFile & { vaultRevision: number };
function message(error: unknown) {
  const code =
    error instanceof Error ? (error.message.split(/[.\s:]/)[0] ?? "") : "";
  const messages: Record<string, string> = {
    version_conflict:
      "The vault changed in another session. Your draft is preserved. Close this dialog, retry loading saved notes and review the latest content before saving again.",
    obsidian_path_exists:
      "This path already exists or is in Trash. Choose another path, restore it, or allow replacement when importing.",
    obsidian_invalid_yaml: "Check the YAML properties or Bases file syntax.",
    obsidian_invalid_canvas:
      "Check the Canvas JSON, node fields and edge references.",
    obsidian_invalid_base:
      "A Bases file needs a views list with a type and name for each view.",
    obsidian_vault_full:
      "Vault limits exceeded: 500 files, 100 KB per file and 5 MB total, including Trash.",
    obsidian_file_too_large:
      "Files must be UTF-8 text, at most 100 KB, without null characters.",
    access_denied:
      "You no longer have permission to manage this organization vault.",
    invalid_request:
      "Check the relative file path, file type and content. Use .md, .canvas or .base without hidden folders or reserved characters.",
  };
  return (
    messages[code] ??
    "Could not complete the vault request. Check your connection and try again."
  );
}
export function Obsidian({
  request,
  workspaceId,
  backTo,
}: {
  request: Request;
  workspaceId: string;
  backTo: string;
}) {
  const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/obsidian`;
  const [data, setData] = useState<ObsidianPage>();
  const [query, setQuery] = useState("");
  const [trash, setTrash] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const sequence = useRef(0);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<{
    path: string;
    content: string;
    revision: number;
    existing: boolean;
  }>();
  const [reader, setReader] = useState<FileView>();
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState<string>();
  const notify = useToast();
  const load = useCallback(async () => {
    const current = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const result = await request<ObsidianPage>(
        `${endpoint}?${new URLSearchParams({ query, trash: String(trash), offset: String(offset) })}`,
      );
      if (current === sequence.current) setData(result);
    } catch (cause) {
      if (current === sequence.current) setError(message(cause));
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }, [endpoint, offset, query, request, trash]);
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  async function action(work: () => Promise<void>, inDialog = false) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      if (inDialog) throw cause;
      setError(message(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function mutate(body: unknown) {
    await request(`${endpoint}/files`, "POST", body);
    await load();
    notify("Organization notes saved.");
  }
  const disabled = loading || busy || !data;
  return (
    <section>
      <PluginDetailHeading title="Obsidian" backTo={backTo}>
        <PluginToggle
          name="Obsidian"
          enabled={data?.settings.enabled}
          disabled={disabled}
          loading={loading}
          onChange={(enabled) =>
            void action(async () => {
              if (!data) return;
              await request(endpoint, "PUT", {
                revision: data.revision,
                enabled,
              });
              await load();
              notify(enabled ? "Obsidian enabled." : "Obsidian disabled.");
            })
          }
        />
      </PluginDetailHeading>
      {error && (
        <ErrorToast message={error}>
          <button
            type="button"
            disabled={busy || loading}
            aria-label="Reload organization notes"
            onClick={() => void load()}
          >
            Retry
          </button>
        </ErrorToast>
      )}
      <section className="card obsidian-card" aria-label="Organization vault">
        <div className="plugin-card-heading coding-card-heading">
          <h2>Organization vault</h2>
          <a className="secondary" href={`${endpoint}/export`} download>
            Export vault
          </a>
        </div>
        <p>
          Shared notes, ready to use. All active members can read and manage
          notes through interactive bot requests. Enabled by default.
        </p>
        <p className="muted">
          Use properties, tags, tasks, links, embeds, callouts, templates and
          daily notes. Canvas and Bases open in Obsidian after export. Desktop
          edits return through Import.
        </p>
        {data && !data.settings.enabled && (
          <p className="notice">
            Bot tools are disabled. Saved notes remain available here.
          </p>
        )}
        <p className="muted">
          500 files · 100 KB per file · 5 MB total, including Trash. Text files
          only; no live synchronization.
        </p>
      </section>
      <section
        className="card obsidian-card"
        aria-label="Organization notes"
        aria-busy={loading || busy}
      >
        <div className="plugin-card-heading coding-card-heading">
          <h2>{trash ? "Trash" : "Notes"}</h2>
          <div className="row obsidian-actions">
            <IconButton
              icon="import"
              label="Import vault"
              showLabel
              disabled={disabled}
              onClick={() => setImporting(true)}
            />
            <IconButton
              icon="add"
              label="New note"
              showLabel
              disabled={disabled || trash}
              onClick={() =>
                data &&
                setEditor({
                  path: "",
                  content: "",
                  revision: data.vaultRevision,
                  existing: false,
                })
              }
            />
          </div>
        </div>
        <div className="obsidian-filters">
          <label className="obsidian-search-field">
            Search notes
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOffset(0);
              }}
              disabled={busy}
              placeholder="Text, path or alias"
            />
          </label>
          <button
            type="button"
            className="secondary"
            aria-pressed={trash}
            disabled={busy}
            onClick={() => {
              setTrash(!trash);
              setOffset(0);
            }}
          >
            Trash
          </button>
        </div>
        {!data && loading ? (
          <SkeletonRows label="Organization notes" />
        ) : (
          data && (
            <>
              {!data.files.length && (
                <p className="muted">
                  {trash
                    ? "Trash is empty."
                    : query
                      ? "No notes match this search."
                      : "No notes yet. Use New or Import to start."}
                </p>
              )}
              <div className="obsidian-list">
                {data.files.map((note) => (
                  <article className="obsidian-note" key={note.path}>
                    <div className="plugin-card-heading coding-card-heading">
                      <div>
                        <button
                          type="button"
                          className="text-button"
                          disabled={disabled}
                          onClick={() =>
                            void action(async () =>
                              setReader(
                                await request<FileView>(
                                  `${endpoint}/file?path=${encodeURIComponent(note.path)}`,
                                ),
                              ),
                            )
                          }
                        >
                          {note.title}
                        </button>
                        <p className="muted obsidian-path">{note.path}</p>
                      </div>
                      <div className="row obsidian-actions">
                        {trash ? (
                          <button
                            type="button"
                            className="secondary"
                            disabled={disabled}
                            onClick={() =>
                              void action(async () =>
                                mutate({
                                  action: "restore",
                                  path: note.path,
                                  revision: data.vaultRevision,
                                }),
                              )
                            }
                          >
                            Restore
                          </button>
                        ) : (
                          <>
                            <IconButton
                              icon="edit"
                              label={`Edit ${note.path}`}
                              showLabel
                              disabled={disabled}
                              onClick={() =>
                                void action(async () => {
                                  const file = await request<FileView>(
                                    `${endpoint}/file?path=${encodeURIComponent(note.path)}`,
                                  );
                                  setEditor({
                                    path: file.path,
                                    content: file.content,
                                    revision: file.vaultRevision,
                                    existing: true,
                                  });
                                })
                              }
                            />
                            <IconButton
                              icon="delete"
                              label={`Trash ${note.path}`}
                              disabled={disabled}
                              onClick={() => setRemoving(note.path)}
                            />
                          </>
                        )}
                      </div>
                    </div>
                    <p className="muted">
                      {note.tags.map((tag) => `#${tag}`).join(" ")}
                      {note.tags.length ? " · " : ""}
                      {note.tasks.filter((t) => !t.done).length} open tasks ·{" "}
                      {note.backlinks.length} backlinks
                    </p>
                  </article>
                ))}
              </div>
              {(offset > 0 || data.nextOffset !== undefined) && (
                <nav
                  className="row obsidian-actions"
                  aria-label="Notes pagination"
                >
                  <button
                    type="button"
                    className="secondary"
                    disabled={disabled || offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - 25))}
                  >
                    Previous
                  </button>
                  <span>
                    {offset + 1}–{offset + data.files.length} of {data.total}
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    disabled={disabled || data.nextOffset === undefined}
                    onClick={() => setOffset(data.nextOffset ?? offset)}
                  >
                    Next
                  </button>
                </nav>
              )}
            </>
          )
        )}
      </section>
      {editor && (
        <NoteEditor
          draft={editor}
          busy={busy}
          close={() => setEditor(undefined)}
          save={(path, content) =>
            action(async () => {
              await mutate({
                action: "save",
                revision: editor.revision,
                path,
                content,
              });
              setEditor(undefined);
            }, true)
          }
        />
      )}
      {reader && (
        <Modal title={reader.path} onClose={() => setReader(undefined)}>
          <div className="obsidian-content">
            <pre>{reader.content}</pre>
          </div>
          <ModalActions>
            <button type="button" onClick={() => setReader(undefined)}>
              Done
            </button>
          </ModalActions>
        </Modal>
      )}
      {importing && data && (
        <VaultImport
          busy={busy}
          close={() => setImporting(false)}
          save={(files, overwrite) =>
            action(async () => {
              await mutate({
                action: "import",
                revision: data.vaultRevision,
                files,
                overwrite,
              });
              setImporting(false);
            }, true)
          }
        />
      )}
      {removing && data && (
        <TrashNote
          path={removing}
          busy={busy}
          close={() => setRemoving(undefined)}
          save={() =>
            action(async () => {
              await mutate({
                action: "trash",
                path: removing,
                revision: data.vaultRevision,
              });
              setRemoving(undefined);
            }, true)
          }
        />
      )}
    </section>
  );
}
function NoteEditor({
  draft,
  busy,
  close,
  save,
}: {
  draft: { path: string; content: string; existing: boolean };
  busy: boolean;
  close: () => void;
  save: (path: string, content: string) => Promise<void>;
}) {
  const [path, setPath] = useState(draft.path);
  const [content, setContent] = useState(draft.content);
  const [error, setError] = useState("");
  return (
    <Modal
      title={draft.existing ? "Edit note" : "New note"}
      busy={busy}
      onClose={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          void save(path, content).catch((cause) => setError(message(cause)));
        }}
      >
        <label>
          Vault path
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            readOnly={draft.existing}
            required
            maxLength={240}
            placeholder="Projects/Launch.md"
          />
        </label>
        <label>
          Content
          <textarea
            className="obsidian-editor"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={100000}
            rows={16}
          />
        </label>
        <p className="muted">
          Markdown, Canvas JSON or Bases YAML. Notes are shared with your
          organization. Rename and template actions are also available through
          the bot.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <ModalActions>
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save note"}
          </button>
        </ModalActions>
      </form>
    </Modal>
  );
}
function VaultImport({
  busy,
  close,
  save,
}: {
  busy: boolean;
  close: () => void;
  save: (
    files: { path: string; content: string }[],
    overwrite: boolean,
  ) => Promise<void>;
}) {
  const [files, setFiles] = useState<{ path: string; content: string }[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  return (
    <Modal title="Import vault" onClose={close} busy={busy || reading}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          void save(files, overwrite).catch((cause) =>
            setError(message(cause)),
          );
        }}
      >
        <label>
          Vault ZIP
          <input
            type="file"
            accept=".zip"
            onChange={(e) => {
              const file = e.target.files?.[0];
              setFiles([]);
              setSkipped([]);
              setError("");
              if (!file) return;
              setReading(true);
              void (async () => {
                try {
                  if (file.size > 5000000)
                    throw Error("ZIP must be at most 5 MB.");
                  const result = importArchive(
                    new Uint8Array(await file.arrayBuffer()),
                  );
                  setFiles(result.files);
                  setSkipped(result.skipped);
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Could not read this ZIP.",
                  );
                } finally {
                  setReading(false);
                }
              })();
            }}
          />
        </label>
        <p className="muted">
          ZIP contents must start at the vault root. Only UTF-8 .md, .canvas and
          .base files are imported. Settings, community plugins and binary
          attachments are skipped.
        </p>
        {files.length > 0 && (
          <details>
            <summary>{files.length} files ready to import</summary>
            <ul>
              {files.map((file) => (
                <li key={file.path}>{file.path}</li>
              ))}
            </ul>
          </details>
        )}
        {skipped.length > 0 && (
          <details>
            <summary>{skipped.length} unsupported files skipped</summary>
            <ul>
              {[...new Set(skipped)].map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          </details>
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
          />
          Replace files with matching paths
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <ModalActions>
          <button type="submit" disabled={busy || reading || !files.length}>
            {busy ? "Importing…" : "Import files"}
          </button>
        </ModalActions>
      </form>
    </Modal>
  );
}
function TrashNote({
  path,
  busy,
  close,
  save,
}: {
  path: string;
  busy: boolean;
  close: () => void;
  save: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  return (
    <Modal title="Move note to Trash" onClose={close} busy={busy}>
      <p>{path} will leave the active vault. You can restore it from Trash.</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <ModalActions>
        <button
          type="button"
          disabled={busy}
          onClick={() => void save().catch((cause) => setError(message(cause)))}
        >
          {busy ? "Moving…" : "Move to Trash"}
        </button>
      </ModalActions>
    </Modal>
  );
}
