import { useContext, useEffect, useState } from "react";
import type { Chat, GroupRepository } from "../src/domain.ts";
import { ModalActions, ModalPending } from "./modal.tsx";
import { Select } from "./select.tsx";
import { Skeleton } from "./skeleton.tsx";

type Request = <T>(
  path: string,
  method?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>;
type RepositoryData = {
  revision: number;
  binding?: GroupRepository;
  available: boolean;
  repositories: { id: number; full_name: string }[];
};

function message(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code.startsWith("version_conflict"))
    return "The group binding changed. Reload the saved repository before trying again.";
  return (
    (
      {
        group_repository_unavailable:
          "This repository is unavailable. Choose an active public repository connected to this workspace.",
        access_denied: "You no longer have permission to change this group.",
      } as Record<string, string>
    )[code] ?? "Could not update the group repository. Try again."
  );
}

export function GroupRepositoryEditor({
  id,
  chat,
  request,
  onSaved,
}: {
  id: string;
  chat: Chat;
  request: Request;
  onSaved: () => void;
}) {
  const [data, setData] = useState<RepositoryData>();
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  const pending = useContext(ModalPending);
  const path = `/api/admin/workspaces/${id}/chats/${chat.id}/repository`;
  useEffect(() => {
    void generation;
    const abort = new AbortController();
    setLoading(true);
    setError("");
    request<RepositoryData>(path, "GET", undefined, abort.signal)
      .then((value) => {
        if (abort.signal.aborted) return;
        setData(value);
        setDraft(value.binding ? String(value.binding.repositoryId) : "");
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError("Could not load group repositories. Try again.");
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [request, path, generation]);
  const available = data?.repositories ?? [];
  const options = available.filter(
    (r) =>
      String(r.id) === draft ||
      r.full_name.toLowerCase().includes(search.toLowerCase()),
  );
  const unavailable = draft && !available.some((r) => String(r.id) === draft);
  return (
    <form
      className="group-link-details"
      aria-label="Group repository"
      aria-busy={loading || saving}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!data || loading || saving) return;
        setSaving(true);
        pending?.(true);
        setError("");
        try {
          await request(path, "PUT", {
            revision: data.revision,
            repositoryId: draft ? Number(draft) : null,
          });
          onSaved();
        } catch (error) {
          setError(message(error));
        } finally {
          setSaving(false);
          pending?.(false);
        }
      }}
    >
      <h3>Repository feedback</h3>
      <p className="muted">
        All group topics use this repository. Feature and bug implementation
        requests must pass a risk check and require the requester's verified
        GitHub write access. Changes produce a checked PR for review.
      </p>
      {!data && loading && (
        <span role="status" aria-label="Saved group repository">
          <Skeleton />
        </span>
      )}
      {data && !data.available && (
        <p role="status">
          The saved binding is unavailable. Select the repository again after
          its connection is repaired, or remove the binding.
        </p>
      )}
      {data && !available.length && (
        <p>
          No active public repositories are connected. Select repositories in
          the GitHub plugin first.
        </p>
      )}
      <label>
        Search repositories
        <input
          type="search"
          value={search}
          disabled={!data || loading || saving}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <label htmlFor={`group-repository-${chat.id}`}>
        Repository
        <Select
          id={`group-repository-${chat.id}`}
          value={draft}
          disabled={!data || loading || saving}
          onChange={(event) => setDraft(event.target.value)}
        >
          <option value="">
            {data
              ? "No group repository"
              : loading
                ? "Loading repository…"
                : "Repository unavailable"}
          </option>
          {unavailable && (
            <option value={draft} disabled>
              {data?.binding?.full_name ?? "Saved repository"} (unavailable)
            </option>
          )}
          {options.map((r) => (
            <option key={r.id} value={r.id}>
              {r.full_name}
            </option>
          ))}
        </Select>
      </label>
      <p className="muted">
        Public repositories only. Private repository work stays in private chat.
        Changing or removing the binding stops earlier group work.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {error && (
        <div className="row">
          <button
            type="button"
            className="secondary"
            disabled={saving || loading}
            onClick={() => setGeneration((v) => v + 1)}
          >
            Reload saved repository
          </button>
        </div>
      )}
      <ModalActions>
        <button
          type="submit"
          disabled={
            !data ||
            loading ||
            saving ||
            (!!draft && !chat.active) ||
            !!unavailable
          }
        >
          {saving ? "Saving…" : "Save repository"}
        </button>
      </ModalActions>
    </form>
  );
}
