import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router";
import type { Capability, Json, JsonObject } from "../src/plugins/contract.ts";
import type { DataSchema } from "../src/plugins/json-schema.ts";
import type {
  PackageCatalog,
  PackagePreview,
  PublicPackageInstallation,
} from "../src/plugins/package-config.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { PluginDetailHeading, PluginToggle } from "./plugin-detail.tsx";
import { Select } from "./select.tsx";
import { Skeleton } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export function packageMessage(cause: unknown): string {
  const code = cause instanceof Error ? cause.message : "";
  const messages: Record<string, string> = {
    version_conflict:
      "Saved plugins changed. Reload the saved settings and check the source again.",
    plugin_preview_expired:
      "This source preview expired. Check the source again.",
    plugin_package_invalid:
      "The source could not be verified. Check the version, manifest, committed bundle and repository access.",
    plugin_manifest_invalid:
      "The manifest uses an invalid or unsupported configuration.",
    plugin_version_republished:
      "This version was already published with different contents. Use a new version.",
    plugin_installation_changed:
      "The installed plugin changed. Reload and review the source again.",
    plugin_source_changed:
      "Source access changed. Reconnect the repository and check the source again.",
    plugin_storage_unavailable:
      "Plugin storage is not configured. Ask the deployment operator to configure the package service.",
    plugin_runner_unavailable:
      "The plugin runner is not configured. Complete the operator setup before enabling.",
    plugin_settings_invalid: "Check the required settings and their limits.",
    plugin_capability_denied:
      "Grant only capabilities requested by this plugin.",
    plugin_connection_required: "Enter a token for this connection.",
    plugin_connection_unavailable:
      "Connection encryption is not configured. Ask the deployment operator to check the service.",
    extension_tool_collision:
      "A local plugin uses one of these tool names. Rename it before enabling.",
    access_denied:
      "Only this workspace's deployment operator can manage plugin code. Personal connections require your own verified membership.",
  };
  return (
    messages[code] ??
    "The request could not be completed. Check your connection and try again."
  );
}

function SourceSummary({
  entry,
}: {
  entry: Pick<PublicPackageInstallation, "manifest" | "source" | "digest">;
}) {
  return (
    <dl className="plugin-summary">
      <div>
        <dt>Source</dt>
        <dd>
          <a
            href={`https://github.com/${entry.source.repository}/tree/${entry.source.commit}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {entry.source.repository}
          </a>
        </dd>
      </div>
      <div>
        <dt>Version</dt>
        <dd>{entry.manifest.version}</dd>
      </div>
      <div>
        <dt>Commit</dt>
        <dd className="mono">{entry.source.commit.slice(0, 12)}</dd>
      </div>
      <div>
        <dt>Capabilities</dt>
        <dd>{entry.manifest.capabilities.join(", ") || "Computation only"}</dd>
      </div>
      <div>
        <dt>Tools</dt>
        <dd>{entry.manifest.tools.map((t) => t.title).join(", ")}</dd>
      </div>
      <div>
        <dt>Package digest</dt>
        <dd className="mono package-digest">{entry.digest}</dd>
      </div>
    </dl>
  );
}

export function PackageSourceModal({
  request,
  workspaceId,
  current,
  rollback,
  onClose,
  saved,
}: {
  request: Request;
  workspaceId: string;
  current?: PublicPackageInstallation;
  rollback?: string;
  onClose: () => void;
  saved: () => void;
}) {
  const base = `/api/admin/workspaces/${workspaceId}/plugin-packages`;
  const [url, setUrl] = useState(current?.manifest.repository ?? "");
  const [ref, setRef] = useState(rollback ?? "");
  const [preview, setPreview] = useState<PackagePreview>();
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const requestId = useRef(crypto.randomUUID());
  const notify = useToast();
  const title = rollback
    ? "Review plugin rollback"
    : current
      ? "Review plugin update"
      : "Install from GitHub";
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      if (!preview) {
        const catalog = await request<PackageCatalog>(base);
        setPreview(
          await request<PackagePreview>(`${base}/previews`, "POST", {
            url,
            ...(ref.trim() ? { ref: ref.trim() } : {}),
            revision: catalog.revision,
            requestId: requestId.current,
            intent: rollback ? "rollback" : current ? "update" : "install",
          }),
        );
      } else if (reviewed) {
        await request(base, "POST", {
          previewId: preview.id,
          revision: preview.revision,
        });
        notify(
          current
            ? "Plugin version saved. Review settings before enabling."
            : "Plugin installed. Configure and enable it when ready.",
        );
        saved();
        onClose();
      }
    } catch (cause) {
      setError(packageMessage(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal title={title} busy={busy} onClose={onClose}>
      <form className="package-form" onSubmit={(event) => void submit(event)}>
        {!preview ? (
          <>
            <p className="muted">
              One repository is one plugin. Review its source and permissions at
              an exact commit. Installation leaves the plugin disabled.
            </p>
            <label className="field">
              <span>GitHub repository</span>
              <input
                type="url"
                required
                maxLength={256}
                placeholder="https://github.com/owner/plugin"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  requestId.current = crypto.randomUUID();
                }}
              />
            </label>
            <label className="field">
              <span>Version tag or full commit</span>
              <input
                maxLength={100}
                placeholder="Latest compatible stable tag"
                value={ref}
                onChange={(e) => {
                  setRef(e.target.value);
                  requestId.current = crypto.randomUUID();
                }}
                required={!!rollback}
              />
            </label>
            <p className="muted">
              Private sources use this workspace's selected GitHub repositories.
              Source visibility grants no access to service data.
            </p>
          </>
        ) : (
          <>
            <h3>{preview.manifest.name}</h3>
            <p>{preview.manifest.description}</p>
            <SourceSummary entry={preview} />
            <a
              href={`https://github.com/${preview.source.repository}/blob/${preview.source.commit}/${preview.manifest.runtime.entry}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Review the exact executable bundle ↗
            </a>
            {!!preview.manifest.connections?.length && (
              <div>
                <h3>External connections</h3>
                {preview.manifest.connections.map((c) => (
                  <p key={c.id}>
                    {c.name} · {c.scope} ·{" "}
                    {c.requests.map((r) => r.origin).join(", ")}
                  </p>
                ))}
                <p className="muted">
                  Approved destinations can receive tool arguments. Tokens
                  remain in the platform.
                </p>
              </div>
            )}
            {current && (
              <details>
                <summary>Review version and permission changes</summary>
                <p>
                  {current.manifest.version} → {preview.manifest.version}
                </p>
                {current.source.ownerId !== preview.source.ownerId && (
                  <p className="notice">
                    The repository owner changed. Review the new publisher.
                  </p>
                )}
                <pre className="package-diff">
                  {JSON.stringify(
                    { installed: current.manifest, incoming: preview.manifest },
                    null,
                    2,
                  )}
                </pre>
              </details>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              <span>I reviewed the source and requested capabilities.</span>
            </label>
            <p className="muted">
              The saved version will be disabled. Updating or rolling back stops
              dependent work; it does not restore old permissions.
            </p>
          </>
        )}
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        {preview && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setPreview(undefined);
              setReviewed(false);
              setError("");
              requestId.current = crypto.randomUUID();
            }}
          >
            Check source again
          </button>
        )}
        <ModalActions>
          <button type="submit" disabled={busy || (preview ? !reviewed : !url)}>
            {busy
              ? "Working…"
              : preview
                ? current
                  ? "Apply reviewed version"
                  : "Install plugin"
                : "Preview plugin"}
          </button>
        </ModalActions>
      </form>
    </Modal>
  );
}

function SettingField({
  name,
  schema,
  value,
  required,
  update,
}: {
  name: string;
  schema: DataSchema;
  value: Json | undefined;
  required: boolean;
  update: (value: Json | undefined) => void;
}) {
  if (schema.type === "boolean")
    return (
      <label className="check">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => update(e.target.checked)}
        />
        <span>{schema.title ?? name}</span>
      </label>
    );
  const label = schema.title ?? name;
  if (schema.enum)
    return (
      <label className="field" htmlFor={`setting-${name}`}>
        <span>{label}</span>
        <Select
          id={`setting-${name}`}
          value={value === undefined ? "" : JSON.stringify(value)}
          required={required}
          onChange={(e) =>
            update(
              e.target.value === "" ? undefined : JSON.parse(e.target.value),
            )
          }
        >
          <option value="">Select</option>
          {schema.enum.map((option) => (
            <option key={JSON.stringify(option)} value={JSON.stringify(option)}>
              {String(option)}
            </option>
          ))}
        </Select>
      </label>
    );
  if (schema.type === "array")
    return (
      <label className="field">
        <span>{label}</span>
        <textarea
          rows={4}
          value={Array.isArray(value) ? value.join("\n") : ""}
          onChange={(e) =>
            update(
              e.target.value
                ? e.target.value
                    .split("\n")
                    .map((line) =>
                      schema.items?.type === "number" ||
                      schema.items?.type === "integer"
                        ? Number(line)
                        : schema.items?.type === "boolean"
                          ? line === "true"
                          : line,
                    )
                : [],
            )
          }
        />
        <small>One value per line. Maximum {schema.maxItems} items.</small>
      </label>
    );
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type={schema.type === "string" ? "text" : "number"}
        required={required}
        value={
          typeof value === "string" || typeof value === "number" ? value : ""
        }
        min={schema.minimum}
        max={schema.maximum}
        step={schema.type === "integer" ? 1 : "any"}
        maxLength={schema.maxLength}
        onChange={(e) =>
          update(
            e.target.value === "" && !required
              ? undefined
              : schema.type === "string"
                ? e.target.value
                : Number(e.target.value),
          )
        }
      />
    </label>
  );
}

function SettingsModal({
  entry,
  revision,
  request,
  base,
  onClose,
  saved,
}: {
  entry: PublicPackageInstallation;
  revision: number;
  request: Request;
  base: string;
  onClose: () => void;
  saved: (view: PackageCatalog) => void;
}) {
  const [settings, setSettings] = useState<JsonObject>(
    structuredClone(entry.settings),
  );
  const [grants, setGrants] = useState<Capability[]>([...entry.grants]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const fields = Object.entries(
    entry.manifest.settingsSchema.properties ?? {},
  ).sort(
    ([a], [b]) =>
      (entry.manifest.settingsUi?.[a]?.order ?? 0) -
      (entry.manifest.settingsUi?.[b]?.order ?? 0),
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      saved(
        await request<PackageCatalog>(
          `${base}/${entry.source.repositoryId}`,
          "PATCH",
          { revision, enabled: entry.enabled, settings, grants },
        ),
      );
      onClose();
    } catch (cause) {
      setError(packageMessage(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal title={`Edit ${entry.manifest.name}`} busy={busy} onClose={onClose}>
      <form className="package-form" onSubmit={(e) => void submit(e)}>
        {!fields.length && (
          <p className="muted">This plugin needs no additional settings.</p>
        )}
        {fields.map(([name, schema]) => (
          <div key={name}>
            <SettingField
              name={name}
              schema={{
                ...schema,
                title: entry.manifest.settingsUi?.[name]?.label ?? schema.title,
              }}
              value={settings[name]}
              required={
                entry.manifest.settingsSchema.required?.includes(name) ?? false
              }
              update={(value) =>
                setSettings((old) => {
                  const next = { ...old };
                  if (value === undefined) delete next[name];
                  else next[name] = value;
                  return next;
                })
              }
            />
            {(entry.manifest.settingsUi?.[name]?.help ??
              schema.description) && (
              <p className="muted">
                {entry.manifest.settingsUi?.[name]?.help ?? schema.description}
              </p>
            )}
          </div>
        ))}
        {!!entry.manifest.capabilities.length && (
          <fieldset>
            <legend>Granted capabilities</legend>
            {entry.manifest.capabilities.map((capability) => (
              <label className="check" key={capability}>
                <input
                  type="checkbox"
                  checked={grants.includes(capability)}
                  onChange={(e) =>
                    setGrants(
                      e.target.checked
                        ? [...grants, capability]
                        : grants.filter((c) => c !== capability),
                    )
                  }
                />
                <span>{capability}</span>
              </label>
            ))}
            <p className="muted">
              Grants remain subject to current member, repository and connection
              access.
            </p>
          </fieldset>
        )}
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        <ModalActions>
          <button type="submit">{busy ? "Saving…" : "Save settings"}</button>
        </ModalActions>
      </form>
    </Modal>
  );
}

function ConnectionModal({
  entry,
  catalog,
  connectionId,
  actor,
  request,
  base,
  onClose,
  saved,
}: {
  entry: PublicPackageInstallation;
  catalog: PackageCatalog;
  connectionId: string;
  actor?: string;
  request: Request;
  base: string;
  onClose: () => void;
  saved: () => void;
}) {
  const descriptor = entry.manifest.connections?.find(
    (c) => c.id === connectionId,
  );
  const previous = entry.connections.find(
    (c) =>
      c.id === connectionId &&
      c.actor === (descriptor?.scope === "member" ? actor : undefined),
  );
  const [token, setToken] = useState("");
  const [members, setMembers] = useState(previous?.members ?? []);
  const [privateOnly, setPrivateOnly] = useState(previous?.privateOnly ?? true);
  const [chats, setChats] = useState(previous?.chats ?? []);
  const [disconnect, setDisconnect] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !descriptor) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await request(
        `${base}/${entry.source.repositoryId}/connections`,
        "POST",
        {
          revision: catalog.revision,
          id: connectionId,
          ...(token ? { token } : {}),
          disconnect,
          members: descriptor.scope === "member" ? [] : members,
          privateOnly: descriptor.scope === "member" || privateOnly,
          chats: descriptor.scope === "member" ? [] : chats,
        },
      );
      setToken("");
      saved();
      onClose();
    } catch (cause) {
      setError(packageMessage(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  if (!descriptor) return null;
  return (
    <Modal title={`Connect ${descriptor.name}`} busy={busy} onClose={onClose}>
      <form className="package-form" onSubmit={(e) => void submit(e)}>
        <p className="muted">
          Approved destinations:{" "}
          {descriptor.requests.map((r) => r.origin).join(", ")}. Credentials
          stay in the platform.
        </p>
        {descriptor.scope === "member" && (
          <p className="muted">
            This connection belongs to your verified Telegram member and can be
            used only in your private conversations.
          </p>
        )}
        {descriptor.auth.type === "bearer" && (
          <label className="field">
            <span>API token</span>
            <input
              type="password"
              autoComplete="new-password"
              maxLength={8192}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                previous?.configured
                  ? "Leave blank to keep the saved token"
                  : "Enter a scoped read-only token"
              }
            />
          </label>
        )}
        {descriptor.scope === "workspace" && (
          <>
            <fieldset>
              <legend>Members allowed to use this connection</legend>
              {catalog.members.map((member) => (
                <label className="check" key={member.id}>
                  <input
                    type="checkbox"
                    checked={members.includes(member.id)}
                    onChange={(e) =>
                      setMembers(
                        e.target.checked
                          ? [...members, member.id]
                          : members.filter((id) => id !== member.id),
                      )
                    }
                  />
                  <span>{member.name}</span>
                </label>
              ))}
            </fieldset>
            <label className="check">
              <input
                type="checkbox"
                checked={privateOnly}
                onChange={(e) => setPrivateOnly(e.target.checked)}
              />
              <span>Private conversations only</span>
            </label>
            {!privateOnly && (
              <fieldset>
                <legend>Allowed group destinations</legend>
                {catalog.chats.map((chat) => (
                  <label className="check" key={chat.id}>
                    <input
                      type="checkbox"
                      checked={chats.includes(chat.id)}
                      onChange={(e) =>
                        setChats(
                          e.target.checked
                            ? [...chats, chat.id]
                            : chats.filter((id) => id !== chat.id),
                        )
                      }
                    />
                    <span>{chat.name}</span>
                  </label>
                ))}
              </fieldset>
            )}
          </>
        )}
        {previous && (
          <label className="check">
            <input
              type="checkbox"
              checked={disconnect}
              onChange={(e) => setDisconnect(e.target.checked)}
            />
            <span>Disconnect and remove this binding</span>
          </label>
        )}
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        <ModalActions>
          <button
            type="submit"
            disabled={descriptor.scope === "member" && !actor}
          >
            {busy ? "Saving…" : disconnect ? "Disconnect" : "Save connection"}
          </button>
        </ModalActions>
      </form>
    </Modal>
  );
}

export function PackageDetail({
  request,
  workspaceId,
  actor,
}: {
  request: Request;
  workspaceId: string;
  actor?: string;
}) {
  const { repositoryId } = useParams();
  const navigate = useNavigate();
  const notify = useToast();
  const base = `/api/admin/workspaces/${workspaceId}/plugin-packages`;
  const back = `/admin/plugins?workspace=${encodeURIComponent(workspaceId)}`;
  const [data, setData] = useState<PackageCatalog>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [source, setSource] = useState<{ rollback?: string }>();
  const [connection, setConnection] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const sequence = useRef(0);
  const lock = useRef(false);
  const load = useCallback(async () => {
    const own = ++sequence.current;
    setLoading(true);
    try {
      const value = await request<PackageCatalog>(base);
      if (own === sequence.current) {
        setData(value);
        setError("");
      }
    } catch (cause) {
      if (own === sequence.current) setError(packageMessage(cause));
    } finally {
      if (own === sequence.current) setLoading(false);
    }
  }, [base, request]);
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  const entry = data?.entries.find(
    (p) => String(p.source.repositoryId) === repositoryId,
  );
  const title = entry?.manifest.name ?? "GitHub plugin";
  async function enable(enabled: boolean) {
    if (!data || !entry || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      setData(
        await request<PackageCatalog>(
          `${base}/${entry.source.repositoryId}`,
          "PATCH",
          {
            revision: data.revision,
            enabled,
            settings: entry.settings,
            grants: entry.grants,
          },
        ),
      );
      notify(enabled ? "Plugin enabled." : "Plugin disabled.");
    } catch (cause) {
      setError(packageMessage(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function remove() {
    if (!data || !entry || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await request(`${base}/${entry.source.repositoryId}`, "DELETE", {
        revision: data.revision,
      });
      notify(
        "Plugin removed. Retained artifacts remain protected for audit and recovery.",
      );
      navigate(back);
    } catch (cause) {
      setError(packageMessage(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="plugin-detail package-detail">
      <PluginDetailHeading title={title} backTo={back}>
        <PluginToggle
          name={title}
          enabled={entry?.enabled}
          loading={loading && !data}
          disabled={
            busy ||
            loading ||
            !entry ||
            (!data?.runnerConfigured && !entry.enabled)
          }
          onChange={(value) => void enable(value)}
        />
      </PluginDetailHeading>
      {error && !editing && connection === undefined && !removing && (
        <ErrorToast message={error}>
          <button
            type="button"
            aria-label="Retry loading plugin package"
            onClick={() => void load()}
          >
            Retry
          </button>
        </ErrorToast>
      )}
      <section
        className="card"
        aria-busy={!data && loading}
        aria-label="Package configuration"
      >
        <div className="plugin-card-heading">
          <h2>Configuration</h2>
          <IconButton
            icon="edit"
            label={`Edit ${title}`}
            showLabel
            disabled={!entry || busy || loading}
            onClick={() => setEditing(true)}
          />
        </div>
        {entry ? (
          <>
            <p className="muted">{entry.manifest.description}</p>
            <SourceSummary entry={entry} />
            <dl className="plugin-summary">
              <div>
                <dt>Granted capabilities</dt>
                <dd>{entry.grants.join(", ") || "None"}</dd>
              </div>
              {Object.entries(entry.settings).map(([name, value]) => (
                <div key={name}>
                  <dt>{entry.manifest.settingsUi?.[name]?.label ?? name}</dt>
                  <dd>
                    {typeof value === "string" ? value : JSON.stringify(value)}
                  </dd>
                </div>
              ))}
            </dl>
            {!data?.runnerConfigured && (
              <p className="notice" role="status">
                The runner is not configured. See the operator's plugin setup
                guide before enabling.
              </p>
            )}
          </>
        ) : data ? (
          <p>This package is not installed in the selected workspace.</p>
        ) : (
          <Skeleton width="100%" height="8rem" />
        )}
      </section>
      {entry && (
        <section className="card" aria-label="Package versions">
          <div className="plugin-card-heading">
            <h2>Version management</h2>
            <IconButton
              icon="refresh"
              label="Check for updates"
              showLabel
              disabled={busy || loading}
              onClick={() => setSource({})}
            />
          </div>
          <p className="muted">
            Updates require reviewing the source and permissions. Applying a
            version leaves the plugin disabled.
          </p>
          {!!entry.history.length && (
            <div className="package-history">
              {entry.history.map((version) => (
                <div className="package-history-row" key={version.digest}>
                  <span>
                    {version.manifest.version} ·{" "}
                    {version.source.commit.slice(0, 12)}
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || loading}
                    onClick={() =>
                      setSource({ rollback: version.source.commit })
                    }
                  >
                    Review rollback to {version.manifest.version}
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="row">
            <IconButton
              icon="delete"
              label="Remove plugin"
              showLabel
              disabled={busy || loading}
              onClick={() => setRemoving(true)}
            />
          </div>
        </section>
      )}
      {entry?.manifest.connections?.map((descriptor) => {
        const saved = entry.connections.find(
          (c) =>
            c.id === descriptor.id &&
            c.actor === (descriptor.scope === "member" ? actor : undefined),
        );
        return (
          <section
            className="card"
            key={descriptor.id}
            aria-label={`Connection ${descriptor.name}`}
          >
            <div className="plugin-card-heading">
              <h2>{descriptor.name}</h2>
              <IconButton
                icon="edit"
                label={`Edit ${descriptor.name} connection`}
                showLabel
                disabled={
                  busy || loading || (descriptor.scope === "member" && !actor)
                }
                onClick={() => setConnection(descriptor.id)}
              />
            </div>
            <dl className="plugin-summary">
              <div>
                <dt>Status</dt>
                <dd>
                  {saved
                    ? saved.configured
                      ? "Configured"
                      : "Token required"
                    : "Not connected"}
                </dd>
              </div>
              <div>
                <dt>Scope</dt>
                <dd>
                  {descriptor.scope === "member"
                    ? "Your private conversations"
                    : "Selected workspace members and destinations"}
                </dd>
              </div>
              <div>
                <dt>Destinations</dt>
                <dd>{descriptor.requests.map((r) => r.origin).join(", ")}</dd>
              </div>
            </dl>
            {descriptor.scope === "member" && !actor && (
              <p className="muted">
                Link this panel account to your Telegram member before
                connecting.
              </p>
            )}
          </section>
        );
      })}
      {entry && data && editing && (
        <SettingsModal
          entry={entry}
          revision={data.revision}
          request={request}
          base={base}
          onClose={() => setEditing(false)}
          saved={(value) => {
            setData(value);
            notify("Plugin settings saved.");
          }}
        />
      )}
      {entry && source && (
        <PackageSourceModal
          request={request}
          workspaceId={workspaceId}
          current={entry}
          rollback={source.rollback}
          onClose={() => setSource(undefined)}
          saved={() => void load()}
        />
      )}
      {entry && data && connection !== undefined && (
        <ConnectionModal
          entry={entry}
          catalog={data}
          connectionId={connection}
          actor={actor}
          request={request}
          base={base}
          onClose={() => setConnection(undefined)}
          saved={() => {
            notify("Plugin connection saved.");
            void load();
          }}
        />
      )}
      {removing && (
        <Modal
          title="Remove plugin"
          busy={busy}
          onClose={() => {
            setRemoving(false);
            setError("");
          }}
        >
          <div className="package-form">
            <p>
              Remove this installation and its connection bindings? Active
              dependent work will stop. Retained source artifacts remain
              protected for audit and recovery.
            </p>
            {error && (
              <p className="notice" role="alert">
                {error}
              </p>
            )}
            <ModalActions>
              <button
                type="button"
                className="danger"
                onClick={() => void remove()}
              >
                {busy ? "Removing…" : "Remove plugin"}
              </button>
            </ModalActions>
          </div>
        </Modal>
      )}
    </section>
  );
}
