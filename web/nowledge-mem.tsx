import { useCallback, useEffect, useRef, useState } from "react";
import type {
  NowledgePage,
  NowledgeSettings,
} from "../src/nowledge-mem/config.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { PluginDetailHeading, PluginToggle } from "./plugin-detail.tsx";
import { Select } from "./select.tsx";
import { Skeleton } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const message = (cause: unknown) => {
  const code = (cause as Error).message;
  if (code.includes("version_conflict"))
    return "These settings changed in another session. Reload and review your draft.";
  if (code.includes("access_denied"))
    return "Access was denied. Check the API key and the selected member’s active membership.";
  if (code.includes("not_configured"))
    return "Enter an API key when changing the server or member, and choose a Space before enabling.";
  if (code.includes("extension_tool_collision"))
    return "A file plugin already uses a Nowledge Mem tool name. Rename its tools before enabling.";
  return "Could not complete the request. Check the server base URL and API key, then retry.";
};
export function NowledgeMem({
  request,
  workspaceId,
  backTo,
}: {
  request: Request;
  workspaceId: string;
  backTo: string;
}) {
  const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/nowledge-mem`;
  const [data, setData] = useState<NowledgePage>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<NowledgeSettings>();
  const [apiKey, setApiKey] = useState("");
  const [removeCredential, setRemoveCredential] = useState(false);
  const [spaces, setSpaces] = useState<{ id: string; name: string }[]>([]);
  const lock = useRef(false),
    sequence = useRef(0),
    notify = useToast();
  const load = useCallback(async () => {
    const own = ++sequence.current;
    try {
      const value = await request<NowledgePage>(endpoint);
      if (own === sequence.current) {
        setData(value);
        setError("");
      }
    } catch {
      if (own === sequence.current)
        setError(
          "Could not load Nowledge Mem settings. Retry when your connection is available.",
        );
    }
  }, [endpoint, request]);
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  async function save(settings: NowledgeSettings, fromEditor = false) {
    if (!data || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    sequence.current++;
    try {
      setData(
        await request<NowledgePage>(endpoint, "PUT", {
          revision: data.revision,
          settings,
          ...(fromEditor && apiKey ? { apiKey } : {}),
          ...(fromEditor && removeCredential ? { removeCredential: true } : {}),
        }),
      );
      setDraft(undefined);
      setApiKey("");
      setRemoveCredential(false);
      notify("Nowledge Mem settings saved.");
    } catch (cause) {
      setError(message(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function discover() {
    if (!draft || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const found = await request<{ id: string; name: string }[]>(
        `${endpoint}/spaces`,
        "POST",
        { apiUrl: draft.apiUrl, ...(apiKey ? { apiKey } : {}) },
      );
      setSpaces(found);
      const selected =
        found.find((s) => s.id === draft.spaceId) ??
        (found.length === 1 ? found[0] : undefined);
      setDraft({
        ...draft,
        spaceId: selected?.id ?? "",
        spaceName: selected?.name ?? "",
      });
      if (!found.length)
        setError(
          "No Spaces were returned. Create a Space in Nowledge Mem, then try again.",
        );
    } catch (cause) {
      setError(message(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const ready =
    data?.credentialConfigured &&
    !!data.settings.apiUrl &&
    !!data.settings.spaceId &&
    !!data.settings.memberId;
  const summary = (value?: string) =>
    data ? value || "Not configured" : <Skeleton width="10rem" />;
  return (
    <section>
      <PluginDetailHeading title="Nowledge Mem" backTo={backTo}>
        <PluginToggle
          name="Nowledge Mem"
          enabled={data?.settings.enabled}
          loading={!data && !error}
          disabled={busy || !data || (!ready && !data.settings.enabled)}
          onChange={(enabled) => {
            if (data) void save({ ...data.settings, enabled });
          }}
        />
      </PluginDetailHeading>
      {error && !draft && (
        <ErrorToast message={error}>
          <button type="button" disabled={busy} onClick={() => void load()}>
            Reload settings
          </button>
        </ErrorToast>
      )}
      <section
        className="card transcription-card"
        aria-label="Nowledge Mem configuration"
        aria-busy={!data || busy}
      >
        <div className="plugin-card-heading">
          <h2>Connection</h2>
          <IconButton
            icon="edit"
            label="Edit Nowledge Mem"
            disabled={!data || busy}
            onClick={() => {
              if (!data) return;
              setDraft({ ...data.settings });
              setApiKey("");
              setRemoveCredential(false);
              setError("");
              setSpaces(
                data.settings.spaceId
                  ? [
                      {
                        id: data.settings.spaceId,
                        name: data.settings.spaceName || data.settings.spaceId,
                      },
                    ]
                  : [],
              );
            }}
          />
        </div>
        <p>
          Recall knowledge from Nowledge Mem in the selected member’s private
          Telegram chat.
        </p>
        <dl className="transcription-summary">
          <div>
            <dt>Server</dt>
            <dd>{summary(data?.settings.apiUrl)}</dd>
          </div>
          <div>
            <dt>Member</dt>
            <dd>
              {summary(
                data?.members.find((m) => m.id === data.settings.memberId)
                  ?.name ?? data?.settings.memberId,
              )}
            </dd>
          </div>
          <div>
            <dt>Space</dt>
            <dd>
              {summary(data?.settings.spaceName || data?.settings.spaceId)}
            </dd>
          </div>
          <div>
            <dt>API key</dt>
            <dd>
              {data ? (
                data.credentialConfigured ? (
                  "Saved securely"
                ) : (
                  "Not configured"
                )
              ) : (
                <Skeleton width="8rem" />
              )}
            </dd>
          </div>
        </dl>
        {data && !ready && (
          <p className="muted">
            Configure the server, API key, member and Space before enabling.
          </p>
        )}
      </section>
      <section
        className="card transcription-card"
        aria-label="Using Nowledge Mem"
      >
        <h2>Private memory</h2>
        <p>
          Ask the bot to search your saved knowledge or read a memory. To save
          exact text, send <strong>Save to Nowledge Mem: your text</strong> or{" "}
          <strong>保存到 Nowledge Mem：你的內容</strong>.
        </p>
        <p className="muted">
          Saves use only that message’s exact text. Chat transcripts are not
          captured automatically. Group chats and scheduled workflows cannot
          access this connection. RepoDesk’s existing conversation memory is
          managed separately.
        </p>
        <a
          href="https://mem.nowledge.co/docs/installation"
          target="_blank"
          rel="noreferrer"
        >
          Nowledge Mem installation guide ↗
        </a>
      </section>
      {draft && data && (
        <Modal
          title="Edit Nowledge Mem"
          busy={busy}
          onClose={() => {
            setDraft(undefined);
            setApiKey("");
            setError("");
          }}
        >
          {error && (
            <div className="notice" role="alert">
              {error}
              {error.includes("another session") && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDraft(undefined);
                    setApiKey("");
                    void load();
                  }}
                >
                  Reload settings
                </button>
              )}
            </div>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save(
                { ...draft, enabled: removeCredential ? false : draft.enabled },
                true,
              );
            }}
          >
            <fieldset disabled={busy} className="plugin-fields nowledge-fields">
              <label className="field">
                <span>Server URL</span>
                <input
                  type="url"
                  required
                  maxLength={2048}
                  placeholder="https://mem.example.com"
                  value={draft.apiUrl}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      apiUrl: event.target.value,
                      spaceId: "",
                      spaceName: "",
                    });
                    setSpaces([]);
                  }}
                />
              </label>
              <p className="muted">
                Use the server base URL from Access Anywhere, without /app or
                /mcp. Local servers can use HTTP on loopback; a container’s
                localhost refers to that container.
              </p>
              <label className="field" htmlFor="nowledge-member">
                <span>Member</span>
                <Select
                  id="nowledge-member"
                  required
                  value={draft.memberId}
                  onChange={(event) =>
                    setDraft({ ...draft, memberId: event.target.value })
                  }
                >
                  <option value="" disabled>
                    Choose a member
                  </option>
                  {data.members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="field">
                <span>API key</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  maxLength={4096}
                  disabled={removeCredential}
                  value={apiKey}
                  placeholder={
                    data.credentialConfigured
                      ? "Leave blank to keep the saved key"
                      : "Enter your Mem API key"
                  }
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
              <p className="muted">
                Use a key for this member’s Mem. Changing the server or member
                requires entering the key again. The saved key is never
                displayed.
              </p>
              <button
                type="button"
                className="secondary"
                disabled={!draft.apiUrl || removeCredential}
                onClick={() => void discover()}
              >
                {busy ? "Working…" : "Find Spaces"}
              </button>
              <label className="field" htmlFor="nowledge-space">
                <span>Space</span>
                <Select
                  id="nowledge-space"
                  required
                  value={draft.spaceId}
                  onChange={(event) => {
                    const selected = spaces.find(
                      (s) => s.id === event.target.value,
                    );
                    setDraft({
                      ...draft,
                      spaceId: selected?.id ?? "",
                      spaceName: selected?.name ?? "",
                    });
                  }}
                >
                  <option value="" disabled>
                    Find and choose a Space
                  </option>
                  {spaces.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </label>
              {data.credentialConfigured && (
                <label className="plugin-check">
                  <input
                    type="checkbox"
                    checked={removeCredential}
                    onChange={(event) => {
                      setRemoveCredential(event.target.checked);
                      setApiKey("");
                    }}
                  />
                  <span>Remove saved API key and disable this plugin</span>
                </label>
              )}
              <ModalActions>
                <button type="submit">{busy ? "Saving…" : "Save"}</button>
              </ModalActions>
            </fieldset>
          </form>
        </Modal>
      )}
    </section>
  );
}
