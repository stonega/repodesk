import { useEffect, useState } from "react";
import { NavLink } from "react-router";
import type { Audit, Session, Settings } from "../../src/domain.ts";
import { settingsSchema } from "../../src/domain.ts";
import {
  Action,
  ApiError,
  api,
  Field,
  Notice,
  Page,
  Pager,
  type Progress,
  useData,
} from "../admin-shared.tsx";
import { GitHubConnection } from "../github.tsx";
import { IconButton } from "../icon-button.tsx";
import { Modal, ModalActions } from "../modal.tsx";
import { Select } from "../select.tsx";
import { currencyField, workspaceFields } from "../settings-fields.ts";
import { Skeleton } from "../skeleton.tsx";
import { ErrorToast, useToast } from "../toast.tsx";
import { Usage } from "../usage.tsx";
import { GroupsAndMembersPage } from "./members-groups.tsx";
import { MissionsPage } from "./missions.tsx";
import { ModelUsagePage } from "./model-usage.tsx";
import { PrivacyPage, ThreadsPage } from "./runs-privacy.tsx";
import {
  InstructionsPage,
  SkillsPage,
  WorkflowsPage,
} from "./workflows-skills.tsx";

export function WorkspacePage({
  id,
  resource,
  admin,
}: {
  id: string;
  resource: string;
  admin: Session["admin"];
}) {
  if (resource === "usage") return <Usage id={id} request={api} />;
  if (resource === "model-usage") return <ModelUsagePage key={id} id={id} />;
  if (resource === "settings") return <SettingsPage key={id} id={id} />;
  if (resource === "skills") return <SkillsPage id={id} />;
  if (resource === "missions") return <MissionsPage key={id} id={id} />;
  if (resource === "workflows") return <WorkflowsPage id={id} />;
  if (resource === "instructions") return <InstructionsPage id={id} />;
  if (resource === "threads") return <ThreadsPage key={id} id={id} />;
  if (resource === "members") return <GroupsAndMembersPage id={id} />;
  if (resource === "deletion") return <PrivacyPage id={id} />;
  return (
    <ReadPage
      key={`${id}:${resource}`}
      id={id}
      resource={resource}
      admin={admin}
    />
  );
}
export function ReadPage({
  id,
  resource,
  admin,
}: {
  id: string;
  resource: string;
  admin: Session["admin"];
}) {
  const { data, error, reload, loading } = useData<{
    settings?: Settings;
    version?: number;
    counts?: {
      members: number;
      runs: number;
      threads: number;
      workflows: number;
      codingTasks?: number;
    };
    connections?: {
      bot: { configured: boolean; username?: string };
      github: { connected: boolean; account?: string; repositories: number };
    };
    items?: Audit[];
  }>(`/api/admin/workspaces/${id}/${resource}`);
  const [current, setCurrent] = useState<{
    version: number;
    settings: Settings;
  }>();
  const [editing, setEditing] = useState(false);
  const notify = useToast();
  const [managingBot, setManagingBot] = useState(false);
  const [managingGitHub, setManagingGitHub] = useState(false);
  const counts = {
    members: data?.counts?.members,
    threads: data?.counts?.threads,
    workflows: data?.counts?.workflows,
    ...(data?.counts?.codingTasks !== undefined
      ? { codingTasks: data.counts.codingTasks }
      : admin.operator && !admin.telegramId
        ? { codingTasks: undefined }
        : {}),
  };
  useEffect(() => {
    if (resource === "overview" && data?.settings && data.version)
      setCurrent({ version: data.version, settings: data.settings });
  }, [resource, data]);
  return (
    <Page
      title={resource === "overview" ? "Your team, in view" : "Audit history"}
      description={
        resource === "overview"
          ? "A shared assistant with explicit permissions and a traceable history."
          : undefined
      }
      actions={
        error && (
          <Action loading={loading} onClick={async () => reload()}>
            Try again
          </Action>
        )
      }
    >
      {error && <Notice error>{error}</Notice>}
      <Pager data={data} />
      {resource === "overview" ? (
        <>
          <section
            className="stats"
            aria-label="Workspace counts"
            aria-busy={loading}
          >
            {Object.entries(counts).map(([key, value]) => (
              <NavLink
                key={key}
                to={`/admin/${key === "codingTasks" ? "plugins/codex" : key}?workspace=${id}${key === "codingTasks" ? "#coding-tasks" : ""}`}
                aria-label={`${value !== undefined ? `${value} ` : loading ? "" : "Unavailable "}${key === "codingTasks" ? "coding tasks" : key}. View details`}
              >
                <strong>
                  {value ??
                    (loading ? <Skeleton width="64px" height="35px" /> : "—")}
                </strong>
                <span>{key === "codingTasks" ? "Coding tasks" : key}</span>
              </NavLink>
            ))}
          </section>
          {(data?.connections || (!data && admin.operator)) && (
            <section className="overview-connections" aria-label="Connections">
              <section
                className="card overview-connection-card"
                aria-label="Telegram bot"
                aria-busy={loading}
              >
                <div className="row overview-connection-heading">
                  <h2>Telegram bot</h2>
                  {data?.connections ? (
                    <span
                      className={`pill${data.connections.bot.configured ? " good" : ""}`}
                    >
                      {data.connections.bot.configured
                        ? "Configured"
                        : "Not configured"}
                    </span>
                  ) : loading ? (
                    <Skeleton width="7em" />
                  ) : null}
                </div>
                <p>
                  {!data?.connections ? (
                    loading ? (
                      <Skeleton width="65%" />
                    ) : (
                      "Unavailable"
                    )
                  ) : data.connections.bot.configured &&
                    data.connections.bot.username ? (
                    <a
                      href={`https://t.me/${encodeURIComponent(data.connections.bot.username)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      @{data.connections.bot.username}
                    </a>
                  ) : (
                    "Connect a Telegram bot to use this workspace in chat."
                  )}
                </p>
                <button
                  type="button"
                  disabled={!data?.connections || loading || !!error}
                  onClick={() => {
                    setManagingBot(true);
                  }}
                >
                  Manage bot
                </button>
              </section>
              <section
                className="card overview-connection-card"
                aria-label="GitHub"
                aria-busy={loading}
              >
                <div className="row overview-connection-heading">
                  <h2>GitHub</h2>
                  {data?.connections ? (
                    <span
                      className={`pill${data.connections.github.connected ? " good" : ""}`}
                    >
                      {data.connections.github.connected
                        ? "Connected"
                        : "Not connected"}
                    </span>
                  ) : loading ? (
                    <Skeleton width="7em" />
                  ) : null}
                </div>
                <p>
                  {!data?.connections ? (
                    loading ? (
                      <Skeleton width="65%" />
                    ) : (
                      "Unavailable"
                    )
                  ) : data.connections.github.connected ? (
                    <>
                      {data.connections.github.account ? (
                        <a
                          href={`https://github.com/${encodeURIComponent(data.connections.github.account)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {data.connections.github.account}
                        </a>
                      ) : (
                        "GitHub App"
                      )}
                      {` · ${data.connections.github.repositories} ${data.connections.github.repositories === 1 ? "repository" : "repositories"}`}
                    </>
                  ) : (
                    "Connect a GitHub App to grant repository access."
                  )}
                </p>
                <button
                  type="button"
                  disabled={!data?.connections || loading || !!error}
                  onClick={() => setManagingGitHub(true)}
                >
                  Manage GitHub
                </button>
              </section>
            </section>
          )}
          {managingBot && (
            <TelegramBotDialog
              onClose={() => setManagingBot(false)}
              onSaved={() => {
                notify("Telegram bot token saved.");
                reload();
              }}
            />
          )}
          {managingGitHub && (
            <GitHubConnection
              request={api}
              workspaceId={id}
              open
              onClose={() => setManagingGitHub(false)}
              onUpdated={() => reload()}
            />
          )}
          <section className="card" aria-label="Team" aria-busy={loading}>
            <div className="row team-card-heading">
              <div>
                <h2>{current?.settings.name ?? "Team configuration"}</h2>
                <p className="muted">
                  Settings version{" "}
                  {current?.version ??
                    (loading ? <Skeleton width="2em" /> : "Unavailable")}
                </p>
              </div>
              <IconButton
                icon="edit"
                label="Edit team configuration"
                disabled={!current || loading || !!error}
                onClick={() => {
                  setEditing(true);
                }}
              />
            </div>
            <ul className="settings-list">
              {workspaceFields.map((field) => (
                <li className="settings-item" key={field.key}>
                  <div className="settings-item-details">
                    <h3>{field.label}</h3>
                    <p className="settings-item-value">
                      {current ? (
                        settingValue(field.key, current.settings[field.key])
                      ) : loading ? (
                        <Skeleton width="60%" />
                      ) : (
                        "Unavailable"
                      )}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
          {editing && current && (
            <WorkspaceSettingsEditor
              id={id}
              current={current}
              onClose={() => setEditing(false)}
              onConflict={() => {
                setEditing(false);
                reload();
              }}
              onSaved={(updated) => {
                setCurrent(updated);
                setEditing(false);
                notify("Team configuration saved.");
                reload();
              }}
            />
          )}
        </>
      ) : (
        <section className="card">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {data?.items?.map((a) => (
                <tr key={a.id}>
                  <td>{new Date(a.at).toLocaleString()}</td>
                  <td>{a.action}</td>
                  <td>{a.actor}</td>
                  <td>{a.target}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </Page>
  );
}
export function TelegramBotDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const {
    data,
    error: loadError,
    loading,
    reload,
  } = useData<Progress>("/api/setup/progress");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Modal title="Manage Telegram bot" onClose={onClose} busy={saving}>
      <form
        aria-busy={saving}
        onSubmit={async (event) => {
          event.preventDefault();
          if (saving || !data || !token.trim()) return;
          setSaving(true);
          setError("");
          try {
            await api("/api/admin/operator/credentials", "PUT", {
              version: data.version,
              botToken: token.trim(),
            });
            setToken("");
            onSaved();
            onClose();
          } catch (cause) {
            const message =
              cause instanceof Error
                ? cause.message
                : "Could not save bot token.";
            setError(message);
            if (message.includes("version_conflict")) reload();
          } finally {
            setSaving(false);
          }
        }}
      >
        {loadError && (
          <>
            <Notice error>{loadError}</Notice>
            <Action loading={loading} onClick={async () => reload()}>
              Try again
            </Action>
          </>
        )}
        {data && !loadError && (
          <>
            <p>
              {data.bot
                ? `Current bot: @${data.bot.username}`
                : "No bot configured."}
            </p>
            <Field label="New bot token">
              <input
                type="text"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                value={token}
                onChange={(event) => {
                  setToken(event.target.value);
                  setError("");
                }}
                placeholder="Paste your BotFather token"
                required
              />
            </Field>
            <p className="muted">
              Saving a token pauses the bot until Telegram reception is ready.
              It activates automatically once the model and skills are
              configured.
            </p>
          </>
        )}
        {error && (
          <p role="alert" className="notice">
            {error}
          </p>
        )}
        <ModalActions>
          <button
            type="submit"
            disabled={!data || !!loadError || loading || !token.trim()}
          >
            {saving ? "Saving…" : "Save token"}
          </button>
        </ModalActions>
      </form>
    </Modal>
  );
}
export function SettingsPage({ id }: { id: string }) {
  const { data, error, reload, loading } = useData<{
    version: number;
    settings: Settings;
  }>(`/api/admin/workspaces/${id}/settings`);
  const [current, setCurrent] = useState<typeof data>();
  const [confirming, setConfirming] = useState(false);
  const [editingCurrency, setEditingCurrency] = useState(false);
  const notify = useToast();
  useEffect(() => {
    if (data) setCurrent(data);
  }, [data]);
  const paused = current?.settings.paused;
  const action = paused ? "Resume workspace" : "Pause workspace";
  return (
    <Page
      title="Workspace settings"
      description="Set your team's preferred currency and manage workspace activity."
    >
      <ErrorToast message={error}>
        <button type="button" disabled={loading} onClick={reload}>
          Retry
        </button>
      </ErrorToast>
      <section
        className="card team-currency-card"
        aria-label="Team currency"
        aria-busy={loading}
      >
        <div className="card-heading">
          <h2>Team currency</h2>
          <IconButton
            icon="edit"
            label="Edit team currency"
            disabled={!current || loading || !!error}
            onClick={() => setEditingCurrency(true)}
          />
        </div>
        <p className="settings-item-value">
          {current ? (
            (current.settings.currency ?? "USD")
          ) : loading ? (
            <Skeleton width="4em" />
          ) : (
            "Unavailable"
          )}
        </p>
        <p className="muted">
          Default currency for assistant responses when no currency is
          specified. Budgets and usage accounting use USD.
        </p>
      </section>
      {editingCurrency && current && (
        <WorkspaceSettingsEditor
          id={id}
          current={current}
          title="Edit team currency"
          fields={[currencyField]}
          onClose={() => setEditingCurrency(false)}
          onConflict={() => {
            setEditingCurrency(false);
            reload();
          }}
          onSaved={(updated) => {
            setCurrent(updated);
            setEditingCurrency(false);
            notify("Team currency saved.");
            reload();
          }}
        />
      )}
      <section
        className="card"
        aria-label="Workspace activity"
        aria-busy={loading}
      >
        <div className="row">
          <h2>Pause workspace</h2>
          {current ? (
            <span className="pill">{paused ? "Paused" : "Active"}</span>
          ) : (
            <Skeleton />
          )}
        </div>
        <p className="muted">
          Pause assistant runs, scheduled work and pending run deliveries in
          this workspace. You can resume work here when you are ready.
        </p>
        <button
          type="button"
          className={paused ? undefined : "danger"}
          disabled={!current || loading || !!error}
          onClick={() => setConfirming(true)}
        >
          {action}
        </button>
      </section>
      {confirming && current && (
        <Modal title={`${action}?`} onClose={() => setConfirming(false)}>
          <p>
            {paused
              ? `Resume work in ${current.settings.name}? New assistant runs and scheduled work will be allowed again. Cancelled runs and deliveries will not restart.`
              : `Pause ${current.settings.name}? This stops workspace execution and cancels queued or running assistant work and pending run deliveries. You can resume the workspace later.`}
          </p>
          <ModalActions>
            <Action
              danger={!paused}
              onConflict={() => {
                setConfirming(false);
                reload();
              }}
              onClick={async () => {
                const updated = await api<NonNullable<typeof current>>(
                  `/api/admin/workspaces/${id}/settings`,
                  "PUT",
                  {
                    version: current.version,
                    settings: { ...current.settings, paused: !paused },
                  },
                );
                setCurrent(updated);
                setConfirming(false);
                notify(paused ? "Workspace resumed." : "Workspace paused.");
                reload();
              }}
            >
              {action}
            </Action>
          </ModalActions>
        </Modal>
      )}
    </Page>
  );
}
function settingValue(key: keyof Settings, value: Settings[keyof Settings]) {
  if (key === "runBudgetUsd" || key === "monthlyBudgetUsd")
    return value === null ? "None" : `$${String(value)}`;
  const units: Partial<Record<keyof Settings, string>> = {
    retentionDays: "days",
    missedRunMinutes: "minutes",
  };
  const unit = units[key];
  return unit ? `${value} ${unit}` : String(value);
}
export function WorkspaceSettingsEditor({
  id,
  current,
  onClose,
  onConflict,
  onSaved,
  title = "Edit team configuration",
  fields = workspaceFields,
}: {
  id: string;
  current: { version: number; settings: Settings };
  onClose: () => void;
  onConflict: () => void;
  onSaved: (updated: { version: number; settings: Settings }) => void;
  title?: string;
  fields?: typeof workspaceFields;
}) {
  const [draft, setDraft] = useState<Settings>(current.settings);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={(event) => event.preventDefault()}>
        {fields.map((field) => {
          const fieldId = `settings-${field.key}`;
          const value = draft[field.key];
          const issue = issues[field.key];
          const budget =
            field.key === "runBudgetUsd" || field.key === "monthlyBudgetUsd";
          if (field.min !== undefined && field.min === field.max)
            return (
              <div className="field" key={field.key}>
                <span>{field.label}</span>
                <strong>{settingValue(field.key, value)}</strong>
                <small>{field.help}</small>
              </div>
            );
          return (
            <div className="field" key={field.key}>
              <label htmlFor={fieldId}>{field.label}</label>
              {field.options ? (
                <Select
                  id={fieldId}
                  value={String(value ?? "USD")}
                  aria-invalid={!!issue}
                  aria-describedby={`${fieldId}-help${issue ? ` ${fieldId}-error` : ""}`}
                  onChange={(event) => {
                    setDraft({ ...draft, [field.key]: event.target.value });
                    setIssues((previous) => ({ ...previous, [field.key]: "" }));
                    setFormError("");
                  }}
                >
                  {field.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              ) : (
                <input
                  id={fieldId}
                  type={
                    typeof value === "boolean"
                      ? "checkbox"
                      : budget || typeof value === "number"
                        ? "number"
                        : "text"
                  }
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  placeholder={budget ? "None" : undefined}
                  checked={typeof value === "boolean" ? value : undefined}
                  value={
                    typeof value === "boolean"
                      ? undefined
                      : value === null || Number.isNaN(value)
                        ? ""
                        : String(value)
                  }
                  aria-invalid={!!issue}
                  aria-describedby={`${fieldId}-help${issue ? ` ${fieldId}-error` : ""}`}
                  onChange={(event) => {
                    const next =
                      typeof value === "boolean"
                        ? event.target.checked
                        : budget || typeof value === "number"
                          ? event.target.value === ""
                            ? budget
                              ? null
                              : Number.NaN
                            : Number(event.target.value)
                          : event.target.value;
                    setDraft({ ...draft, [field.key]: next });
                    setIssues((previous) => ({ ...previous, [field.key]: "" }));
                    setFormError("");
                  }}
                />
              )}
              <small id={`${fieldId}-help`}>{field.help}</small>
              {issue && (
                <small id={`${fieldId}-error`} role="alert">
                  {issue}
                </small>
              )}
            </div>
          );
        })}
        {formError && (
          <Notice error>
            {formError}
            {formError.includes("version_conflict") && (
              <button type="button" className="secondary" onClick={onConflict}>
                Reload current version
              </button>
            )}
          </Notice>
        )}
        <ModalActions>
          <Action
            type="submit"
            resetKey={draft}
            onError={setFormError}
            onClick={async () => {
              const parsed = settingsSchema.safeParse(draft);
              if (!parsed.success) {
                setIssues(
                  Object.fromEntries(
                    parsed.error.issues.map((item) => [
                      String(item.path[0]),
                      item.message,
                    ]),
                  ),
                );
                throw new Error("Check the highlighted fields.");
              }
              try {
                const updated = await api<{
                  version: number;
                  settings: Settings;
                }>(`/api/admin/workspaces/${id}/settings`, "PUT", {
                  version: current.version,
                  settings: parsed.data,
                });
                onSaved(updated);
              } catch (error) {
                if (error instanceof ApiError)
                  setIssues(
                    Object.fromEntries(
                      error.issues.map((item) => [
                        item.path.replace(/^settings\./, ""),
                        item.message,
                      ]),
                    ),
                  );
                throw error;
              }
            }}
          >
            Save configuration
          </Action>
        </ModalActions>
      </form>
    </Modal>
  );
}
