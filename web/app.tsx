import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useSearchParams,
} from "react-router";
import {
  type ThinkingLevel,
  thinkingLevels,
} from "../src/agent/model-settings.ts";
import type {
  Approval,
  Audit,
  Chat,
  Delivery,
  Instruction,
  Member,
  Run,
  Session,
  Settings,
  Skill,
  SkillSpec,
  Workflow,
} from "../src/domain.ts";
import { type ActionIcon, IconButton } from "./icon-button.tsx";
import { RuntimeLogs } from "./logs.tsx";
import { CreateModal, Modal, ModalPending } from "./modal.tsx";
import { Plugins } from "./plugins.tsx";
import "./style.css";

let csrf = "";
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(csrf ? { "x-csrf-token": csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      response.status === 409 && data.error === "version_conflict"
        ? `${data.error}. Reload the current version and review your changes before saving again.`
        : response.status === 401
          ? "Your session expired. Sign in again."
          : data.error === "setup_incomplete"
            ? "Finish bot credentials, model configuration and Telegram reception before activating."
            : data.error === "verified_owner_and_skill_required"
              ? "Verify a workspace owner and enable a published skill before activating."
              : data.error === "https_origin_required"
                ? "Webhook mode requires a public HTTPS address. For local use, set TELEGRAM_TRANSPORT=polling and restart the app and worker."
                : (data.error ?? "Request failed"),
    );
  return data;
}
function useData<T>(path: string) {
  const [params] = useSearchParams();
  const offset = params.get("offset") ?? "0";
  const resourcePath =
    /\/(runs|audit|workflows|skills|instructions|members|chats|usage)$/.test(
      path,
    )
      ? `${path}?offset=${Math.max(0, Number(offset) || 0)}`
      : path;
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    void revision; // Reload explicitly invalidates the fetched resource.
    let live = true;
    setError("");
    api<T>(resourcePath)
      .then((value) => {
        if (live) setData(value);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [resourcePath, revision]);
  return { data, error, reload };
}
function Pager({ data }: { data: unknown }) {
  const [params, setParams] = useSearchParams();
  const total = (data as { total?: number } | undefined)?.total ?? 0;
  const offset = Number(params.get("offset")) || 0;
  if (total <= 100 && offset === 0) return null;
  return (
    <div className="row">
      <IconButton
        icon="previous"
        label="Previous page"
        type="button"
        disabled={offset === 0}
        onClick={() => setParams({ offset: String(Math.max(0, offset - 100)) })}
      />
      <span>
        {offset + 1}–{Math.min(offset + 100, total)} of {total}
      </span>
      <IconButton
        icon="next"
        label="Next page"
        type="button"
        disabled={offset + 100 >= total}
        onClick={() => setParams({ offset: String(offset + 100) })}
      />
    </div>
  );
}
function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="notice" role="status">
      {children}
    </p>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: Every Field receives a native input, textarea, or select as its child.
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Action({
  children,
  icon,
  onClick,
  danger = false,
  disabled = false,
}: {
  children: string;
  icon?: ActionIcon;
  onClick: () => Promise<unknown>;
  danger?: boolean;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const setModalPending = useContext(ModalPending);
  const perform = async () => {
    setBusy(true);
    setModalPending?.(true);
    setError("");
    try {
      await onClick();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setModalPending?.(false);
    }
  };
  return (
    <span className="action">
      {icon ? (
        <IconButton
          icon={icon}
          label={children}
          className={danger ? "danger" : ""}
          disabled={disabled}
          busy={busy}
          onClick={perform}
        />
      ) : (
        <button
          type="button"
          className={danger ? "danger" : ""}
          disabled={busy || disabled}
          aria-busy={busy}
          onClick={perform}
        >
          {busy ? "Working…" : children}
        </button>
      )}
      {icon && (
        <span className="sr-only" aria-live="polite">
          {busy ? `${children}: Working…` : ""}
        </span>
      )}
      {error && <Notice>{error}</Notice>}
    </span>
  );
}
function Json({ value }: { value: unknown }) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}
function JsonForm({
  value,
  save,
  label = "Save changes",
}: {
  value: unknown;
  save: (value: unknown) => Promise<unknown>;
  label?: string;
}) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  useEffect(() => setText(JSON.stringify(value, null, 2)), [value]);
  return (
    <div className="editor">
      <Field label="Configuration (JSON)">
        <textarea
          rows={14}
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
      </Field>
      <Action onClick={() => save(JSON.parse(text))}>{label}</Action>
    </div>
  );
}
function Page({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <div className="page-heading">
        <p className="eyebrow">DEEPX / TEAM OPERATIONS</p>
        <div className="page-title-row">
          <h1>{title}</h1>
          {actions && <div className="page-actions">{actions}</div>}
        </div>
        {description && <p className="muted">{description}</p>}
      </div>
      {children}
    </>
  );
}
function Auth({ claim, onDone }: { claim: boolean; onDone: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (claim && values.password !== values.confirm) {
      setError("Passwords do not match");
      return;
    }
    delete values.confirm;
    setBusy(true);
    try {
      const result = await api<{ csrf: string }>(
        claim ? "/api/setup/claim" : "/api/admin/auth/login",
        "POST",
        values,
      );
      csrf = result.csrf;
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page
      title={claim ? "Make this workspace yours" : "Welcome back"}
      description={
        claim
          ? "Claim your deployment with the one-use token generated on your host."
          : "Sign in to manage your team assistant."
      }
    >
      <form className="card narrow" onSubmit={submit}>
        {claim && (
          <>
            <Notice>
              On your host, run: docker compose exec app node dist/operator.js
              claim. Tokens expire after 15 minutes.
            </Notice>
            <Field label="Bootstrap token">
              <input name="token" type="password" required autoComplete="off" />
            </Field>
          </>
        )}
        <Field label="Username">
          <input
            name="username"
            required
            autoComplete="username"
            pattern="[a-zA-Z0-9_.-]{3,64}"
          />
        </Field>
        <Field label="Password">
          <input
            name="password"
            type="password"
            minLength={12}
            maxLength={256}
            required
            autoComplete={claim ? "new-password" : "current-password"}
          />
        </Field>
        {claim && (
          <Field label="Confirm password">
            <input
              name="confirm"
              type="password"
              required
              autoComplete="new-password"
            />
          </Field>
        )}
        {error && <Notice>{error}</Notice>}
        <button type="submit" disabled={busy}>
          {busy ? "Please wait…" : claim ? "Create administrator" : "Sign in"}
        </button>
      </form>
    </Page>
  );
}
interface Progress {
  version: number;
  active: boolean;
  bot?: { id: string; username: string; visibleAll: boolean };
  model: string;
  modelBaseUrl: string;
  thinkingLevel: ThinkingLevel;
  modelPricing?: { input: number; output: number };
  webhookReady: boolean;
  telegramTransport: "webhook" | "polling";
  receiver: { ready: boolean; error?: string };
  paused: boolean;
  credentials: { bot: boolean; model: boolean };
  workspaces: {
    id: string;
    version: number;
    settings: Settings;
    ownerVerified: boolean;
    skills: { id: string; name: string; enabled: boolean }[];
    deleted: boolean;
  }[];
}
function Setup() {
  const { data, error, reload } = useData<Progress>("/api/setup/progress");
  const [identity, setIdentity] = useState<{ url: string; command: string }>();
  const [selected, setSelected] = useState("");
  useEffect(() => {
    if (data?.telegramTransport !== "polling") return;
    const timer = setInterval(reload, 5000);
    return () => clearInterval(timer);
  }, [data?.telegramTransport, reload]);
  if (!data) return <Notice>{error || "Loading setup…"}</Notice>;
  const workspace =
    data.workspaces.find((w) => w.id === selected) ??
    data.workspaces.find((w) => !w.deleted);
  const missing = [
    !workspace && "Save a workspace.",
    !data.credentials.bot && "Save a Telegram bot token.",
    !data.credentials.model && "Save a model API key.",
    !data.receiver.ready &&
      (data.telegramTransport === "polling"
        ? "Wait for the polling worker to connect."
        : "Register the verification webhook."),
    !workspace?.ownerVerified && "Verify the workspace owner through Telegram.",
    workspace &&
      !workspace.skills.some((s) => s.enabled) &&
      "Enable a published skill.",
  ].filter((item): item is string => typeof item === "string");
  return (
    <Page
      title={data.active ? "Deployment settings" : "Set up your team assistant"}
      description="Each step is saved. You can leave and resume later. Credentials are write-only."
    >
      <div className="steps">
        <span className="pill good">1 · Admin created</span>
        <span className="pill">
          2 · {workspace ? "Workspace saved" : "Workspace"}
        </span>
        <span className="pill">
          3 · {data.bot ? "Bot checked" : "Telegram"}
        </span>
        <span className="pill">
          4 · {data.credentials.model ? "Model saved" : "Model configuration"}
        </span>
        <span className="pill">
          5 · {workspace?.ownerVerified ? "Owner verified" : "Verify owner"}
        </span>
        <span className="pill">
          6 · {data.active ? "Active" : "Review & activate"}
        </span>
      </div>
      <section className="card">
        <h2>Workspace</h2>
        {data.workspaces.length > 0 && (
          <Field label="Workspace draft">
            <select
              value={workspace?.id ?? ""}
              onChange={(e) => setSelected(e.target.value)}
            >
              {data.workspaces
                .filter((w) => !w.deleted)
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.settings.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        {workspace ? (
          <>
            <p>
              {workspace.settings.name} · {workspace.settings.timezone} ·{" "}
              {workspace.settings.retentionDays} day retention
            </p>
            {!workspace.ownerVerified && (
              <JsonForm
                value={{
                  version: workspace.version,
                  settings: workspace.settings,
                }}
                save={async (value) => {
                  await api(
                    `/api/setup/workspaces/${workspace.id}`,
                    "PUT",
                    value,
                  );
                  reload();
                }}
              />
            )}
          </>
        ) : (
          <CreateModal label="Add workspace" title="Create workspace">
            {(close) => (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                }}
              >
                <Field label="Workspace name">
                  <input id="workspace-name" defaultValue="My team" />
                </Field>
                <Field label="Timezone">
                  <input
                    id="workspace-timezone"
                    defaultValue={
                      Intl.DateTimeFormat().resolvedOptions().timeZone
                    }
                  />
                </Field>
                <Action
                  onClick={async () => {
                    await api("/api/setup/workspaces", "POST", {
                      name: (
                        document.getElementById(
                          "workspace-name",
                        ) as HTMLInputElement
                      ).value,
                      timezone: (
                        document.getElementById(
                          "workspace-timezone",
                        ) as HTMLInputElement
                      ).value,
                    });
                    close();
                    reload();
                  }}
                >
                  Save workspace
                </Action>
              </form>
            )}
          </CreateModal>
        )}
      </section>
      <section className="card">
        <h2>Connect Telegram</h2>
        <p className="muted">
          Create a dedicated bot with BotFather. Saving its token calls Telegram
          to verify its identity. You can configure the model before connecting
          a bot.
        </p>
        <TelegramCredentialForm progress={data} reload={reload} />
      </section>
      <section className="card" aria-labelledby="setup-model-heading">
        <h2 id="setup-model-heading">Model configuration</h2>
        <p className="muted">
          Connect an OpenAI-compatible provider with its base URL and API key.
          Choose a suggested model or enter your own model ID, then select a
          supported thinking level. Saving does not make a model request.
        </p>
        <ModelCredentialForm progress={data} reload={reload} />
      </section>
      <section className="card">
        <h2>Verify the owner</h2>
        <p>
          {data.telegramTransport === "polling"
            ? "Local polling is enabled. The worker receives Telegram updates without a public URL or HTTPS webhook. Save your bot token, wait for Polling: ready, then open the one-use Telegram link."
            : "Register the HTTPS webhook to receive verification commands, then open the one-use Telegram link."}{" "}
          Ordinary bot requests stay inactive until activation.
        </p>
        <div className="row">
          {data.telegramTransport === "webhook" && (
            <Action
              onClick={async () => {
                await api("/api/setup/webhook", "POST", {});
                reload();
              }}
            >
              {data.webhookReady
                ? "Reconcile webhook"
                : "Register verification webhook"}
            </Action>
          )}
          {workspace && (
            <Action
              disabled={!data.receiver.ready || !data.credentials.bot}
              onClick={async () =>
                setIdentity(
                  await api(`/api/setup/identity/${workspace.id}`, "POST", {}),
                )
              }
            >
              Generate owner verification link
            </Action>
          )}
        </div>
        {identity && (
          <Notice>
            <a href={identity.url} target="_blank" rel="noreferrer">
              Verify with Telegram
            </a>
            <br />
            {identity.command}
            <br />
            Expires in 15 minutes. After verification, sign in again.
          </Notice>
        )}
        <p>
          {data.telegramTransport === "polling" ? "Polling" : "Webhook"}:{" "}
          {data.receiver.ready ? "ready" : "pending"} · Owner:{" "}
          {workspace?.ownerVerified ? "verified" : "pending"}
        </p>
      </section>
      {data.telegramTransport === "polling" && data.receiver.error && (
        <Notice>
          {data.receiver.error === "polling_webhook_conflict"
            ? "This bot already has a webhook. Stop the other deployment and deliberately remove its webhook before using polling; no pending updates have been discarded."
            : data.receiver.error === "telegram_polling_conflict"
              ? "Another receiver is using this bot. Stop the other polling process or webhook before retrying."
              : data.receiver.error === "bot_not_configured"
                ? "Save your Telegram bot token to start polling."
                : data.receiver.error === "telegram_unauthorized"
                  ? "Telegram rejected the saved bot token. Save a valid token to reconnect."
                  : "Polling could not receive updates. Check the worker and its connection to Telegram; it will retry automatically."}
        </Notice>
      )}
      <section className="card">
        <h2>Review & activate</h2>
        <p>Bot: {data.bot ? `@${data.bot.username}` : "not configured"}</p>
        <dl
          className="setup-model-summary"
          aria-label="Saved model configuration"
        >
          <dt>API</dt>
          <dd>OpenAI-compatible</dd>
          <dt>Base URL</dt>
          <dd>{data.modelBaseUrl}</dd>
          <dt>Model</dt>
          <dd>{data.model}</dd>
          <dt>Thinking level</dt>
          <dd>{data.thinkingLevel}</dd>
          <dt>API key</dt>
          <dd>
            {data.credentials.model
              ? "Configured"
              : "Missing — save model configuration to continue"}
          </dd>
        </dl>
        <p>
          Workspace starts with whitelist-only access. Verification enrolls and
          allows its owner. Group context defaults to directed messages.
        </p>
        <p>
          Starter skills:{" "}
          {workspace?.skills
            .filter((s) => s.enabled)
            .map((s) => s.name)
            .join(", ") || "none"}
          . Manage versions, settings and enabled skills in the Skills screen
          after owner verification.
        </p>
        <p>
          Budget:{" "}
          {workspace
            ? `$${workspace.settings.runBudgetUsd}/run, $${workspace.settings.monthlyBudgetUsd}/month.`
            : "Save a workspace to configure budgets."}{" "}
          Group linking is optional and starts with /linktoken in a private bot
          chat.
        </p>
        {!data.active && missing.length > 0 && (
          <ul aria-label="Remaining setup steps">
            {missing.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
        <div className="row">
          <Action
            disabled={missing.length > 0}
            onClick={async () => {
              await api("/api/setup/activate", "POST", {});
              reload();
            }}
          >
            Activate bot
          </Action>
          <Action
            icon="refresh"
            onClick={async () => {
              reload();
            }}
          >
            Refresh saved progress
          </Action>
        </div>
        {data.active && <Notice>Active. Open the bot and send /start.</Notice>}
      </section>
    </Page>
  );
}
function TelegramCredentialForm({
  progress: p,
  reload,
}: {
  progress: Progress;
  reload: () => void;
}) {
  const [bot, setBot] = useState("");
  const [saved, setSaved] = useState(false);
  return (
    <>
      <Field
        label={`Bot token · ${p.credentials.bot ? "configured" : "missing"}`}
      >
        <input
          type="password"
          autoComplete="off"
          value={bot}
          onChange={(e) => {
            setBot(e.target.value);
            setSaved(false);
          }}
          placeholder={
            p.credentials.bot
              ? "Leave blank to retain"
              : "Paste your BotFather token"
          }
        />
      </Field>
      <Action
        onClick={async () => {
          if (!bot.trim()) throw new Error("Enter a bot token to save.");
          await api("/api/admin/operator/credentials", "PUT", {
            version: p.version,
            botToken: bot,
          });
          setBot("");
          setSaved(true);
          reload();
        }}
      >
        Save Telegram token
      </Action>
      {saved && <Notice>Telegram token saved. Secret input cleared.</Notice>}
    </>
  );
}
function ModelCredentialForm({
  progress: p,
  reload,
}: {
  progress: Progress;
  reload: () => void;
}) {
  const [key, setKey] = useState("");
  const [model, setModel] = useState(p.model);
  const [baseUrl, setBaseUrl] = useState(p.modelBaseUrl);
  const [thinking, setThinking] = useState(p.thinkingLevel);
  const [inputPrice, setInputPrice] = useState(
    p.modelPricing?.input.toString() ?? "",
  );
  const [outputPrice, setOutputPrice] = useState(
    p.modelPricing?.output.toString() ?? "",
  );
  const [saved, setSaved] = useState(false);
  return (
    <>
      <div className="columns">
        <Field
          label={`Model API key · ${p.credentials.model ? "configured" : "missing"}`}
        >
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={
              p.credentials.model
                ? "Leave blank to retain"
                : "Enter your provider API key"
            }
          />
        </Field>
        <Field label="Model base URL">
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
          />
        </Field>
        <Field label="Model">
          <input
            list="model-suggestions"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="Select or enter a custom model ID"
          />
          <datalist id="model-suggestions">
            <option value="gpt-4.1-mini" />
            <option value="gpt-4.1" />
            <option value="gpt-4o-mini" />
          </datalist>
        </Field>
        <Field label="Thinking level">
          <select
            value={thinking}
            onChange={(e) => setThinking(e.target.value as ThinkingLevel)}
          >
            {thinkingLevels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Input price (USD / million tokens)">
          <input
            type="number"
            min="0"
            step="any"
            value={inputPrice}
            onChange={(e) => setInputPrice(e.target.value)}
            placeholder="Catalog price"
          />
        </Field>
        <Field label="Output price (USD / million tokens)">
          <input
            type="number"
            min="0"
            step="any"
            value={outputPrice}
            onChange={(e) => setOutputPrice(e.target.value)}
            placeholder="Catalog price"
          />
        </Field>
      </div>
      <p className="muted">
        Include the API path (usually /v1). Enter the API key again when
        changing endpoints. Thinking levels require model support; off omits
        reasoning effort. Custom models need both token prices for budget
        estimates; use 0 for a free local model. Saved price overrides remain
        until you replace them.
      </p>
      <Action
        onClick={async () => {
          if (!!inputPrice !== !!outputPrice)
            throw new Error("Enter both token prices.");
          await api("/api/admin/operator/credentials", "PUT", {
            version: p.version,
            modelKey: key || undefined,
            model,
            modelBaseUrl: baseUrl,
            thinkingLevel: thinking,
            modelPricing:
              inputPrice !== "" && outputPrice !== ""
                ? { input: Number(inputPrice), output: Number(outputPrice) }
                : undefined,
          });
          setKey("");
          setSaved(true);
          reload();
        }}
      >
        Save model configuration
      </Action>
      {saved && (
        <Notice>Model configuration saved. API key input cleared.</Notice>
      )}
    </>
  );
}
function WorkspacePage({ id, resource }: { id: string; resource: string }) {
  if (resource === "settings") return <SettingsPage id={id} />;
  if (resource === "access-policy") return <AccessPage id={id} />;
  if (resource === "skills") return <SkillsPage id={id} />;
  if (resource === "workflows") return <WorkflowsPage id={id} />;
  if (resource === "instructions") return <InstructionsPage id={id} />;
  if (resource === "runs") return <RunsPage id={id} />;
  if (resource === "members") return <MembersPage id={id} />;
  if (resource === "chats") return <ChatsPage id={id} />;
  if (resource === "deletion") return <PrivacyPage id={id} />;
  return <ReadPage id={id} resource={resource} />;
}
function ReadPage({ id, resource }: { id: string; resource: string }) {
  const { data, error, reload } = useData<{
    settings?: Settings;
    version?: number;
    counts?: { members: number; runs: number; workflows: number };
    items?: Audit[];
    totalUsd?: number;
    budget?: number;
  }>(`/api/admin/workspaces/${id}/${resource}`);
  return (
    <Page
      title={
        resource === "overview"
          ? "Your team, in view"
          : resource === "usage"
            ? "Usage & budget"
            : "Audit history"
      }
      description={
        resource === "overview"
          ? "A shared assistant with explicit permissions and a traceable history."
          : undefined
      }
      actions={
        <Action icon="refresh" onClick={async () => reload()}>
          Refresh
        </Action>
      }
    >
      {error && <Notice>{error}</Notice>}
      <Pager data={data} />
      {data?.counts ? (
        <>
          <div className="stats">
            {Object.entries(data.counts).map(([key, value]) => (
              <div key={key}>
                <strong>{value}</strong>
                <span>{key}</span>
              </div>
            ))}
          </div>
          <section className="card">
            <h2>{data.settings?.name}</h2>
            <p>
              {data.settings?.timezone} · Settings version {data.version}
            </p>
            <p>
              Start in Telegram with /help, or review queued work under Runs.
            </p>
          </section>
        </>
      ) : resource === "usage" ? (
        <section className="card">
          <h2>${data?.totalUsd?.toFixed(4) ?? "0"}</h2>
          <p>
            Recorded spend including unresolved reservations. Monthly limit: $
            {data?.budget}.
          </p>
          <Json value={data} />
        </section>
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
function SettingsPage({ id }: { id: string }) {
  const { data, error, reload } = useData<{
    version: number;
    settings: Settings;
  }>(`/api/admin/workspaces/${id}/settings`);
  const [settings, setSettings] = useState<Settings>();
  useEffect(() => setSettings(data?.settings), [data]);
  return (
    <Page
      title="Workspace settings"
      description="Changes apply to future runs. Pause and tighter budgets apply immediately."
    >
      {error && <Notice>{error}</Notice>}
      {settings && data && (
        <section className="card">
          <div className="columns">
            {Object.entries(settings).map(([key, value]) => (
              <Field key={key} label={key}>
                {typeof value === "boolean" ? (
                  <input
                    type="checkbox"
                    checked={value}
                    onChange={(e) =>
                      setSettings({ ...settings, [key]: e.target.checked })
                    }
                  />
                ) : (
                  <input
                    type={typeof value === "number" ? "number" : "text"}
                    step="any"
                    value={value}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        [key]:
                          typeof value === "number"
                            ? Number(e.target.value)
                            : e.target.value,
                      })
                    }
                  />
                )}
              </Field>
            ))}
          </div>
          <p>Effective version: {data.version}</p>
          <div className="row">
            <Action
              onClick={async () => {
                await api(`/api/admin/workspaces/${id}/settings`, "PUT", {
                  version: data.version,
                  settings,
                });
                reload();
              }}
            >
              Save settings
            </Action>
            <Action icon="refresh" onClick={async () => reload()}>
              Reload current version
            </Action>
          </div>
        </section>
      )}
    </Page>
  );
}
function AccessPage({ id }: { id: string }) {
  const { data, error, reload } = useData<{
    version: number;
    mode: "whitelist" | "members";
    allowed: string[];
    members: Member[];
  }>(`/api/admin/workspaces/${id}/access-policy`);
  const [text, setText] = useState("");
  const [mode, setMode] = useState("whitelist");
  const [preview, setPreview] = useState<unknown>();
  const [search, setSearch] = useState("");
  useEffect(() => {
    if (data) {
      setText(data.allowed.join("\n"));
      setMode(data.mode);
      setPreview(undefined);
    }
  }, [data]);
  const input = () => ({
    version: data?.version,
    mode,
    allowed: [...new Set(text.split(/[\s,]+/).filter(Boolean))],
  });
  return (
    <Page
      title="Allowed users"
      description="Eligibility is separate from membership and role. An empty whitelist denies workspace access."
    >
      {error && <Notice>{error}</Notice>}
      <section className="card">
        <Field label="Access mode">
          <select
            value={mode}
            onChange={(e) => {
              setMode(e.target.value);
              setPreview(undefined);
            }}
          >
            <option value="whitelist">Whitelist only</option>
            <option value="members">Active workspace members</option>
          </select>
        </Field>
        <Field label="Telegram user IDs (one per line or comma separated)">
          <textarea
            rows={8}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPreview(undefined);
            }}
          />
        </Field>
        <p>
          {mode === "members"
            ? "Editing the saved list does not revoke access in members mode."
            : "Removing eligibility cancels pending work and suspends owned schedules."}{" "}
          Last-admin management access is protected.
        </p>
        <div className="row">
          <Action
            onClick={async () =>
              setPreview(
                await api(
                  `/api/admin/workspaces/${id}/access-policy/preview`,
                  "POST",
                  input(),
                ),
              )
            }
          >
            Preview affected work
          </Action>
          {preview !== undefined && (
            <Action
              onClick={async () => {
                await api(
                  `/api/admin/workspaces/${id}/access-policy`,
                  "PUT",
                  input(),
                );
                reload();
              }}
            >
              Apply reviewed policy
            </Action>
          )}
          <Action icon="refresh" onClick={async () => reload()}>
            Reload current version
          </Action>
        </div>
        {preview !== undefined && <Json value={preview} />}
        <p>Policy version {data?.version}</p>
      </section>
      <section className="card">
        <Field label="Search allowed IDs">
          <input value={search} onChange={(e) => setSearch(e.target.value)} />
        </Field>
        <ul>
          {data?.allowed
            .filter((s) => s.includes(search))
            .map((s) => (
              <li key={s}>
                {s} ·{" "}
                {data.members.find((m) => m.id === s)?.role ?? "not enrolled"}
              </li>
            ))}
        </ul>
      </section>
    </Page>
  );
}
function MembersPage({ id }: { id: string }) {
  const { data, error, reload } = useData<{ items: Member[] }>(
    `/api/admin/workspaces/${id}/members`,
  );
  const policy = useData<{ version: number }>(
    `/api/admin/workspaces/${id}/access-policy`,
  );
  const [member, setMember] = useState({
    id: "",
    role: "member",
    active: true,
    allow: true,
  });
  const [open, setOpen] = useState(false);
  const [editingMember, setEditingMember] = useState(false);
  return (
    <Page
      title="Members"
      description="Enrollment and whitelist access are explicit. Typed IDs grant membership, not proof of identity for browser sessions."
      actions={
        <IconButton
          icon="add"
          label="Add member"
          onClick={() => {
            setMember({ id: "", role: "member", active: true, allow: true });
            setEditingMember(false);
            setOpen(true);
          }}
        />
      }
    >
      {error && <Notice>{error}</Notice>}
      <Pager data={data} />
      <section className="card">
        <ul>
          {data?.items.map((m) => (
            <li key={m.id}>
              {m.id} · {m.role} · {m.active ? "active" : "removed"}{" "}
              {m.role !== "owner" && (
                <IconButton
                  icon="edit"
                  label={`Edit member ${m.id}`}
                  type="button"
                  onClick={() => {
                    setMember({ ...m, allow: false });
                    setEditingMember(true);
                    setOpen(true);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      </section>
      {open && (
        <Modal
          title={editingMember ? "Edit member" : "Add member"}
          onClose={() => setOpen(false)}
        >
          <Field label="Telegram user ID">
            <input
              value={member.id}
              onChange={(e) => setMember({ ...member, id: e.target.value })}
            />
          </Field>
          <Field label="Role">
            <select
              value={member.role}
              onChange={(e) => setMember({ ...member, role: e.target.value })}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
          <Field label="Active membership">
            <input
              type="checkbox"
              checked={member.active}
              onChange={(e) =>
                setMember({ ...member, active: e.target.checked })
              }
            />
          </Field>
          <Field label="Also allow in whitelist">
            <input
              type="checkbox"
              checked={member.allow}
              onChange={(e) =>
                setMember({ ...member, allow: e.target.checked })
              }
            />
          </Field>
          <Action
            onClick={async () => {
              await api(`/api/admin/workspaces/${id}/members`, "POST", {
                ...member,
                version: policy.data?.version,
              });
              reload();
              policy.reload();
              setOpen(false);
            }}
          >
            Save membership
          </Action>
        </Modal>
      )}
    </Page>
  );
}
function ChatsPage({ id }: { id: string }) {
  const { data, error, reload } = useData<{ items: Chat[] }>(
    `/api/admin/workspaces/${id}/chats`,
  );
  return (
    <Page
      title="Group access"
      description="One explicitly connected group per workspace. Send /linktoken privately to the bot, then /link TOKEN in a group where you are an admin."
    >
      {error && <Notice>{error}</Notice>}
      <Pager data={data} />
      {data?.items.map((chat) => (
        <section className="card" key={chat.id}>
          <h2>{chat.id}</h2>
          <p>
            {chat.active ? "Linked" : "Inactive"} ·{" "}
            {chat.visibleAll
              ? "Receives group messages"
              : "Directed visibility"}{" "}
            · Collection: {chat.collection ? "enabled" : "directed only"}
          </p>
          <p>
            Opt-in collection may include received messages from people outside
            the whitelist. Group replies are visible to everyone in the group.
            Old history is unavailable.
          </p>
          <div className="row">
            <Action
              icon="refresh"
              onClick={async () => {
                await api(
                  `/api/admin/workspaces/${id}/chats/${chat.id}/visibility`,
                  "POST",
                  {},
                );
                reload();
              }}
            >
              Recheck bot visibility
            </Action>
            {(["collect", "directed", "unlink"] as const).map((action) => (
              <Action
                key={action}
                danger={action === "unlink"}
                onClick={async () => {
                  await api(
                    `/api/admin/workspaces/${id}/chats/${chat.id}/action`,
                    "POST",
                    { action },
                  );
                  reload();
                }}
              >
                {action === "collect"
                  ? "Consent to collection"
                  : action === "directed"
                    ? "Directed messages only"
                    : "Unlink group"}
              </Action>
            ))}
          </div>
        </section>
      ))}
    </Page>
  );
}
function ApprovalList({
  id,
  reloadParent,
}: {
  id: string;
  reloadParent?: () => void;
}) {
  const { data, error, reload } = useData<{ items: Approval[] }>(
    `/api/admin/workspaces/${id}/approvals`,
  );
  return (
    <section className="card">
      <h2>Awaiting your approval</h2>
      {error && <Notice>{error}</Notice>}
      <Action icon="refresh" onClick={async () => reload()}>
        Refresh proposals
      </Action>
      {data?.items.length === 0 && <p>No pending proposals.</p>}
      {data?.items.map((a) => (
        <article key={a.id}>
          <h3>
            {a.kind} · v{a.version}
          </h3>
          <p>Expires {new Date(a.expiresAt).toLocaleString()}</p>
          <Json value={a.payload} />
          <div className="row">
            {[true, false].map((approve) => (
              <Action
                key={String(approve)}
                danger={!approve}
                onClick={async () => {
                  await api(
                    `/api/admin/workspaces/${id}/approvals/${a.id}`,
                    "POST",
                    { approve },
                  );
                  reload();
                  reloadParent?.();
                }}
              >
                {approve ? "Approve exact proposal" : "Reject"}
              </Action>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}
function WorkflowsPage({ id }: { id: string }) {
  const { data, error, reload } = useData<{
    items: (Workflow & { next: string[] })[];
  }>(`/api/admin/workspaces/${id}/workflows`);
  const skills = useData<{ items: Skill[] }>(
    `/api/admin/workspaces/${id}/skills`,
  );
  const [editing, setEditing] = useState<Workflow>();
  const [creating, setCreating] = useState(false);
  const closeEditor = () => {
    setCreating(false);
    setEditing(undefined);
  };
  const [proposal, setProposal] = useState<unknown>();
  const initial = {
    name: "Friday team recap",
    task: "Summarize decisions, blockers and next steps with source IDs.",
    chatId: "",
    topicId: 0,
    recurrence: {
      frequency: "weekly",
      hour: 17,
      minute: 0,
      weekday: 5,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    format: "Decisions, blockers, next steps",
    budgetUsd: 0.1,
    skillId: skills.data?.items[0]?.id ?? "",
    windowDays: 7,
  };
  return (
    <Page
      title="Scheduled workflows"
      description="Daily and weekly schedules use the displayed timezone. Late runs over five minutes are skipped; daylight-saving gaps are skipped and repeated times run once."
      actions={
        <>
          <IconButton
            icon="add"
            label="Add workflow"
            onClick={() => setCreating(true)}
          />
          <Action icon="refresh" onClick={async () => reload()}>
            Refresh workflows
          </Action>
        </>
      }
    >
      {error && <Notice>{error}</Notice>}
      <Pager data={data} />
      {data?.items.map((f) => (
        <section className="card" key={f.id}>
          <div className="row">
            <h2>{f.spec.name}</h2>
            <span className="pill">{f.status}</span>
          </div>
          <p>
            Owner {f.owner} · Version {f.version} · Skill v{f.skillVersion}
          </p>
          <p>Next: {f.next.join(" · ")}</p>
          <p>
            Source/destination {f.spec.chatId}, topic {f.spec.topicId} · $
            {f.spec.budgetUsd}/run
          </p>
          <div className="row">
            <IconButton
              icon="edit"
              label="Edit proposal"
              type="button"
              onClick={() => setEditing(f)}
            />
            {(["run", "pause", "resume", "delete"] as const).map((action) => (
              <Action
                icon={
                  (
                    {
                      run: undefined,
                      pause: "pause",
                      resume: "play",
                      delete: "delete",
                    } as const
                  )[action]
                }
                key={action}
                danger={action === "delete"}
                onClick={async () => {
                  await api(
                    `/api/admin/workspaces/${id}/workflows/${f.id}/action`,
                    "POST",
                    { version: f.version, action },
                  );
                  reload();
                }}
              >
                {action}
              </Action>
            ))}
          </div>
        </section>
      ))}
      {(creating || editing) && (
        <Modal
          title={editing ? `Edit ${editing.spec.name}` : "Propose a schedule"}
          onClose={closeEditor}
        >
          <p>
            Use a linked group ID or your verified Telegram ID for private
            delivery. Editing requires a new approval. Unsupported recurrence
            needs clarification.
          </p>
          <JsonForm
            value={
              editing
                ? { version: editing.version, spec: editing.spec }
                : initial
            }
            label="Preview approval proposal"
            save={async (value) => {
              const result = await api(
                `/api/admin/workspaces/${id}/workflows${editing ? `/${editing.id}` : ""}`,
                editing ? "PUT" : "POST",
                value,
              );
              setProposal(result);
              closeEditor();
              reload();
            }}
          />
        </Modal>
      )}
      {proposal !== undefined && (
        <section className="card" aria-label="Created workflow proposal">
          <Json value={proposal} />
        </section>
      )}
      <ApprovalList id={id} reloadParent={reload} />
    </Page>
  );
}
function SkillsPage({ id }: { id: string }) {
  const { data, error, reload } = useData<{
    items: (Skill & { dependents: unknown[] })[];
  }>(`/api/admin/workspaces/${id}/skills`);
  const [editing, setEditing] = useState<Skill>();
  const [creating, setCreating] = useState(false);
  const closeEditor = () => {
    setCreating(false);
    setEditing(undefined);
  };
  const [result, setResult] = useState<unknown>();
  const [sample, setSample] = useState(
    "Alice: release is ready. Bob: docs are blocked on review.",
  );
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState("");
  const [pin, setPin] = useState(1);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const spec: SkillSpec = {
    slug: "my-recap",
    name: "My recap",
    description: "A team-specific recap",
    body: "Summarize supplied sources and cite [source:ID]. Distinguish facts and suggestions.",
    tools: ["read_chat_context", "read_instructions", "load_skill"],
    settings: { sections: "Decisions, blockers, next steps", maxWords: 400 },
  };
  return (
    <Page
      title="Agent skills"
      description="Instruction Markdown only. Declared tools request existing capabilities; they cannot grant access or perform external writes."
      actions={
        <>
          <IconButton
            icon="add"
            label="Add skill"
            onClick={() => setCreating(true)}
          />
          <IconButton
            icon="import"
            label="Import skill"
            onClick={() => {
              setImported("");
              setImporting(true);
            }}
          />
        </>
      }
    >
      {error && <Notice>{error}</Notice>}
      <Pager data={data} />
      <div className="row">
        <Field label="Search skills">
          <input value={search} onChange={(e) => setSearch(e.target.value)} />
        </Field>
        <Field label="Skill state">
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </Field>
      </div>
      {data?.items
        .filter(
          (s) =>
            `${s.draft.name} ${s.draft.slug}`
              .toLowerCase()
              .includes(search.toLowerCase()) &&
            (filter === "all" || (filter === "enabled") === s.enabled),
        )
        .map((s) => (
          <section className="card" key={s.id}>
            <div className="row">
              <h2>{s.draft.name}</h2>
              <span className="pill">{s.enabled ? "Enabled" : "Disabled"}</span>
            </div>
            <p>
              {s.draft.description} · Revision {s.version} ·{" "}
              {s.published.length} published versions
            </p>
            <details>
              <summary>Preview instructions & dependent schedules</summary>
              <p className="prose">{s.draft.body}</p>
              <Json
                value={{
                  settings: s.draft.settings,
                  tools: s.draft.tools,
                  dependents: s.dependents,
                }}
              />
            </details>
            <div className="row">
              <IconButton
                icon="edit"
                label="Edit draft"
                type="button"
                onClick={() => setEditing(s)}
              />
              {(
                [
                  "publish",
                  s.enabled ? "disable" : "enable",
                  "archive",
                ] as const
              ).map((action) => (
                <Action
                  icon={
                    action === "publish"
                      ? undefined
                      : action === "archive"
                        ? "archive"
                        : action === "disable"
                          ? "pause"
                          : "play"
                  }
                  key={action}
                  danger={action === "archive"}
                  onClick={async () => {
                    await api(
                      `/api/admin/workspaces/${id}/skills/${s.id}/action`,
                      "POST",
                      { version: s.version, action },
                    );
                    reload();
                  }}
                >
                  {action}
                </Action>
              ))}
              <Action
                onClick={async () => {
                  setResult(
                    await api(
                      `/api/admin/workspaces/${id}/skills/${s.id}/test`,
                      "POST",
                      { sample },
                    ),
                  );
                  reload();
                }}
              >
                Test draft policy
              </Action>
            </div>
            <div className="row">
              <Field label="Rollback source version">
                <input
                  type="number"
                  min={1}
                  max={s.published.length}
                  value={pin}
                  onChange={(e) => setPin(Number(e.target.value))}
                />
              </Field>
              <Action
                onClick={async () => {
                  await api(
                    `/api/admin/workspaces/${id}/skills/${s.id}/action`,
                    "POST",
                    { version: s.version, action: "rollback", pin },
                  );
                  reload();
                }}
              >
                Publish rollback as new version
              </Action>
            </div>
          </section>
        ))}
      {(creating || editing) && (
        <Modal
          title={editing ? `Edit ${editing.draft.name}` : "Create skill"}
          onClose={closeEditor}
        >
          <JsonForm
            value={
              editing ? { version: editing.version, spec: editing.draft } : spec
            }
            label="Save draft"
            save={async (value) => {
              await api(
                `/api/admin/workspaces/${id}/skills${editing ? `/${editing.id}` : ""}`,
                editing ? "PUT" : "POST",
                value,
              );
              closeEditor();
              reload();
            }}
          />
        </Modal>
      )}
      <section className="card">
        <h2>Test skill policy</h2>
        <Field label="Sample input for deterministic test">
          <textarea
            value={sample}
            onChange={(e) => setSample(e.target.value)}
          />
        </Field>
        <p>
          Tests validate policy and show model-visible content. They make no
          paid model request and publish no message.
        </p>
        {result !== undefined && <Json value={result} />}
      </section>
      {importing && (
        <Modal
          title="Import SKILL.md"
          onClose={() => {
            setImporting(false);
            setImported("");
          }}
        >
          <p>
            Frontmatter supports name (a lowercase slug), description, and
            allowed-tools (space separated). Archives, executable bundles, and
            other metadata are rejected.
          </p>
          <Field label="Markdown file">
            <input
              type="file"
              accept=".md,text/markdown"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file && file.size <= 16384) setImported(await file.text());
              }}
            />
          </Field>
          <Field label="Markdown contents">
            <textarea
              rows={8}
              value={imported}
              onChange={(e) => setImported(e.target.value)}
            />
          </Field>
          <Action
            onClick={async () => {
              await api(`/api/admin/workspaces/${id}/skills/import`, "POST", {
                markdown: imported,
              });
              setImported("");
              setImporting(false);
              reload();
            }}
          >
            Import draft
          </Action>
        </Modal>
      )}
    </Page>
  );
}
function InstructionsPage({ id }: { id: string }) {
  const { data, error, reload } = useData<{ items: Instruction[] }>(
    `/api/admin/workspaces/${id}/instructions`,
  );
  const [editing, setEditing] = useState<Instruction>();
  const [creating, setCreating] = useState(false);
  const closeEditor = () => {
    setCreating(false);
    setEditing(undefined);
  };
  return (
    <Page
      title="Shared instructions"
      description="Approved corrections apply to future runs. In-flight runs retain their starting version. Personal instructions never enter group context."
      actions={
        <IconButton
          icon="add"
          label="Add instruction"
          onClick={() => setCreating(true)}
        />
      }
    >
      {error && <Notice>{error}</Notice>}
      <Pager data={data} />
      {data?.items.map((i) => (
        <section className="card" key={i.id}>
          <p className="pill">
            {i.scope} · v{i.version}
          </p>
          <p className="prose">{i.body}</p>
          <p className="muted">
            Author {i.author} · Source {i.provenance}
          </p>
          <div className="row">
            <IconButton
              icon="edit"
              label="Propose edit"
              type="button"
              onClick={() => setEditing(i)}
            />
            <Action
              icon="delete"
              danger
              onClick={async () => {
                await api(
                  `/api/admin/workspaces/${id}/instructions/${i.id}`,
                  "DELETE",
                  { version: i.version },
                );
                reload();
              }}
            >
              Forget
            </Action>
          </div>
        </section>
      ))}
      {(creating || editing) && (
        <Modal
          title={editing ? "Review correction" : "Propose an instruction"}
          onClose={closeEditor}
        >
          <JsonForm
            value={
              editing
                ? {
                    body: editing.body,
                    scope: editing.scope,
                    workflowId: editing.workflowId,
                    replaceId: editing.id,
                  }
                : { body: "", scope: "workspace" }
            }
            label="Create approval proposal"
            save={async (value) => {
              await api(
                `/api/admin/workspaces/${id}/instructions`,
                "POST",
                value,
              );
              closeEditor();
              reload();
            }}
          />
        </Modal>
      )}
      <ApprovalList id={id} reloadParent={reload} />
    </Page>
  );
}
function RunsPage({ id }: { id: string }) {
  const { data, error, reload } = useData<{
    items: (Run & { deliveries: Delivery[] })[];
  }>(`/api/admin/workspaces/${id}/runs`);
  return (
    <Page
      title="Runs & delivery"
      description="Generation and delivery have separate states. An unknown send is never automatically repeated."
      actions={
        <>
          <CreateModal label="Request a run">
            {(close) => (
              <>
                <JsonForm
                  value={{
                    task: "Create a source-grounded team recap.",
                    chatId: "",
                    topicId: 0,
                  }}
                  label="Queue request"
                  save={async (value) => {
                    await api(
                      `/api/admin/workspaces/${id}/runs`,
                      "POST",
                      value,
                    );
                    close();
                    reload();
                  }}
                />
              </>
            )}
          </CreateModal>
          <Action icon="refresh" onClick={async () => reload()}>
            Refresh runs
          </Action>
        </>
      }
    >
      {error && <Notice>{error}</Notice>}
      <Pager data={data} />
      {data?.items.map((r) => (
        <section className="card" key={r.id}>
          <div className="row">
            <h2>{r.task.slice(0, 90)}</h2>
            <span className="pill">{r.status}</span>
          </div>
          <p className="mono">{r.id}</p>
          <p>
            {new Date(r.at).toLocaleString()} · {r.model} · Settings v
            {r.settingsVersion}{" "}
            {r.workflowVersion ? `· Workflow v${r.workflowVersion}` : ""}
          </p>
          {r.error && <Notice>{r.error}</Notice>}
          <p className="prose">{r.result}</p>
          <p className="muted">{r.coverage}</p>
          <details>
            <summary>Versions, usage, checkpoints & delivery</summary>
            <Json
              value={{
                skillPins: r.skillPins,
                instructions: r.instructions.map((i) => ({
                  id: i.id,
                  version: i.version,
                })),
                attempts: r.attempts,
                transcript: r.transcript,
                deliveries: r.deliveries,
              }}
            />
          </details>
          <RunRecovery id={id} run={r} reload={reload} />
          <div className="row">
            <Action
              icon="stop"
              onClick={async () => {
                await api(
                  `/api/admin/workspaces/${id}/runs/${r.id}/cancel`,
                  "POST",
                  {},
                );
                reload();
              }}
            >
              Cancel
            </Action>
            {["failed", "partial", "cancelled"].includes(r.status) && (
              <Action
                onClick={async () => {
                  await api(
                    `/api/admin/workspaces/${id}/runs/${r.id}/retry`,
                    "POST",
                    {},
                  );
                  reload();
                }}
              >
                Create retry (new budget)
              </Action>
            )}
          </div>
        </section>
      ))}
    </Page>
  );
}
function RunRecovery({
  id,
  run,
  reload,
}: {
  id: string;
  run: Run & { deliveries: Delivery[] };
  reload: () => void;
}) {
  return (
    <>
      {run.attempts
        .filter((a) => a.status === "unknown")
        .map((a) => (
          <details key={a.id}>
            <summary>Reconcile unknown charge {a.id}</summary>
            <p>
              Inspect the provider billing record first. This releases the
              reservation using the actual charge you enter.
            </p>
            <JsonForm
              value={{ attemptId: a.id, actualUsd: a.reserved, reference: "" }}
              label="Record verified charge"
              save={async (value) => {
                await api(
                  `/api/admin/workspaces/${id}/runs/${run.id}/reconcile`,
                  "POST",
                  value,
                );
                reload();
              }}
            />
          </details>
        ))}
      {run.deliveries
        .filter((d) => d.state === "delivery_unknown")
        .map((d) => (
          <details key={d.id}>
            <summary>Resolve unknown delivery {d.id}</summary>
            <p>
              Inspect Telegram first. Confirm the remote message ID, or abandon
              this delivery. Neither action resends it.
            </p>
            <JsonForm
              value={{ action: "confirm_sent", remoteId: 0 }}
              label="Resolve observed outcome"
              save={async (value) => {
                await api(
                  `/api/admin/workspaces/${id}/deliveries/${d.id}/resolve`,
                  "POST",
                  value,
                );
                reload();
              }}
            />
            <Action
              onClick={async () => {
                await api(
                  `/api/admin/workspaces/${id}/deliveries/${d.id}/resolve`,
                  "POST",
                  { action: "abandon" },
                );
                reload();
              }}
            >
              Abandon without resend
            </Action>
          </details>
        ))}
    </>
  );
}
function PrivacyPage({ id }: { id: string }) {
  const { data, error, reload } = useData<unknown>(
    `/api/admin/workspaces/${id}/deletion`,
  );
  const [confirm, setConfirm] = useState("");
  return (
    <Page
      title="Privacy & removal"
      description="Deletion revokes access immediately, cancels pending work, and purges stored content on the worker sweep."
    >
      {error && <Notice>{error}</Notice>}
      <section className="card">
        <Json value={data} />
        <p>
          No provider-hosted sessions are created. API providers may retain
          request data according to your account policy; this application cannot
          erase those records.
        </p>
        <Field label="Type DELETE to request complete workspace removal">
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        {confirm === "DELETE" && (
          <Action
            danger
            onClick={async () => {
              await api(`/api/admin/workspaces/${id}/deletion`, "POST", {});
              reload();
            }}
          >
            Request deletion approval
          </Action>
        )}
      </section>
      <ApprovalList id={id} reloadParent={reload} />
    </Page>
  );
}
function Operations() {
  const { data, error, reload } = useData<{
    workers: number;
    failed_runs: number;
    unknown_deliveries: number;
    pending: number;
    oldest_seconds: number;
    paused: boolean;
    audit: unknown[];
  }>("/api/admin/operator/health");
  const progress = useData<Progress>("/api/setup/progress");
  const [accountResult, setAccountResult] = useState<unknown>();
  const [diagnosticId, setDiagnosticId] = useState("");
  const [diagnostic, setDiagnostic] = useState<unknown>();
  return (
    <Page
      title="Operations"
      description="Service health and deployment controls. Operator privileges do not grant access to private conversations."
    >
      {error && <Notice>{error}</Notice>}
      <p>
        <NavLink to="/admin/logs">View runtime logs</NavLink>
      </p>
      <section className="card">
        <p>
          Live workers: {data?.workers} · Pending dispatch: {data?.pending} ·
          Oldest pending: {Math.round(data?.oldest_seconds ?? 0)} seconds ·
          Failed runs: {data?.failed_runs} · Unknown deliveries:{" "}
          {data?.unknown_deliveries}
        </p>
        <Action
          onClick={async () => {
            await api("/api/admin/operator/pause", "POST", {
              paused: !data?.paused,
              version: progress.data?.version,
            });
            reload();
            progress.reload();
          }}
        >
          {data?.paused ? "Resume deployment" : "Pause deployment"}
        </Action>
        <Action
          icon="refresh"
          onClick={async () => {
            reload();
            progress.reload();
          }}
        >
          Refresh
        </Action>
        <Field label="Diagnose by run ID">
          <input
            value={diagnosticId}
            onChange={(e) => setDiagnosticId(e.target.value)}
          />
        </Field>
        <Action
          onClick={async () =>
            setDiagnostic(await api(`/api/admin/operator/runs/${diagnosticId}`))
          }
        >
          Inspect redacted status
        </Action>
        {diagnostic !== undefined && <Json value={diagnostic} />}
        <Json value={data?.audit} />
      </section>
      <section className="card">
        <div className="row">
          <h2>Panel accounts</h2>
          <CreateModal label="Create panel account">
            {(close) => (
              <>
                <p>
                  New accounts have no operator privileges. Link their Telegram
                  identity and enroll them separately.
                </p>
                <JsonForm
                  value={{ username: "", password: "" }}
                  label="Create account"
                  save={async (value) => {
                    setAccountResult(
                      await api("/api/admin/operator/accounts", "POST", value),
                    );
                    close();
                  }}
                />
              </>
            )}
          </CreateModal>
        </div>
        {accountResult !== undefined && <Json value={accountResult} />}
        <h3>Issue identity verification</h3>
        <p>
          Enroll the intended Telegram ID in Members first. Verification
          succeeds only for an eligible workspace member.
        </p>
        <JsonForm
          value={{
            accountId: "",
            workspaceId: progress.data?.workspaces[0]?.id ?? "",
          }}
          label="Issue one-use link"
          save={async (value) => {
            const input = value as { accountId: string; workspaceId: string };
            setAccountResult(
              await api(
                `/api/admin/operator/accounts/${input.accountId}/link`,
                "POST",
                { workspaceId: input.workspaceId },
              ),
            );
          }}
        />
      </section>
      <section className="card">
        <h2>Recover workspace access</h2>
        <p>
          This audited operator action restores an existing owner or admin. It
          does not grant access to private conversations.
        </p>
        <JsonForm
          value={{
            workspaceId: progress.data?.workspaces[0]?.id ?? "",
            telegramId: "",
          }}
          label="Restore management access"
          save={async (value) => {
            const input = value as { workspaceId: string; telegramId: string };
            await api(
              `/api/admin/operator/recover/${input.workspaceId}`,
              "POST",
              { telegramId: input.telegramId },
            );
            reload();
          }}
        />
      </section>
      <section className="card">
        <h2>Workspace setup & purge status</h2>
        <Json value={progress.data?.workspaces} />
      </section>
    </Page>
  );
}
function Shell() {
  const [current, setCurrent] = useState<Session>();
  const [initialized, setInitialized] = useState<boolean>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>(
    [],
  );
  const navigate = useNavigate();
  const [locationParams] = useSearchParams();
  const requestedWorkspace = locationParams.get("workspace");
  useEffect(() => {
    if (
      requestedWorkspace &&
      workspaces.some((w) => w.id === requestedWorkspace)
    )
      setWorkspace(requestedWorkspace);
  }, [requestedWorkspace, workspaces]);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const status = await api<{ initialized: boolean }>("/api/setup/status");
      setInitialized(status.initialized);
      try {
        const s = await api<Session>("/api/admin/auth/session");
        csrf = s.csrf;
        setCurrent(s);
        setWorkspaces(await api("/api/admin/workspaces"));
      } catch {
        setCurrent(undefined);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const chosen = workspace || workspaces[0]?.id || "";
  const navigation = [
    ["overview", "Overview"],
    ["settings", "Settings"],
    ["access-policy", "Allowed users"],
    ["members", "Members"],
    ["chats", "Group access"],
    ["workflows", "Workflows"],
    ["skills", "Skills"],
    ["instructions", "Instructions"],
    ["runs", "Runs"],
    ["usage", "Usage"],
    ["audit", "Audit"],
    ["deletion", "Privacy"],
  ];
  return (
    <div className="layout">
      <aside>
        <div className="brand">
          <span className="mark">D</span>
          <div>
            DeepX<span>TEAM ASSISTANT</span>
          </div>
        </div>
        {current ? (
          <>
            <div className="workspace-picker">
              <Field label="Workspace">
                <select
                  value={chosen}
                  onChange={(e) => setWorkspace(e.target.value)}
                >
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                  {!workspaces.length && (
                    <option>Verify Telegram to continue</option>
                  )}
                </select>
              </Field>
            </div>
            <nav>
              {chosen &&
                navigation.map(([path, label]) => (
                  <NavLink key={path} to={`/admin/${path}`}>
                    {label}
                  </NavLink>
                ))}
              {chosen && current.admin.operator && (
                <NavLink to="/admin/plugins">Plugins</NavLink>
              )}
              {current.admin.operator && (
                <>
                  <p className="nav-label">DEPLOYMENT</p>
                  <NavLink to="/setup">Setup & credentials</NavLink>
                  <NavLink to="/admin/operations">Operations</NavLink>
                  <NavLink to="/admin/logs">Runtime logs</NavLink>
                </>
              )}
            </nav>
            <div className="account">
              <small>
                {current.admin.username}
                {current.admin.telegramId
                  ? ` · ${current.admin.telegramId}`
                  : " · Telegram unlinked"}
              </small>
              <Action
                icon="logout"
                onClick={async () => {
                  await api("/api/admin/auth/logout", "POST", {});
                  csrf = "";
                  setCurrent(undefined);
                }}
              >
                Sign out
              </Action>
              <IconButton
                icon="refresh"
                label="Refresh session"
                type="button"
                onClick={() => void load()}
              />
            </div>
          </>
        ) : (
          <p className="sidebar-note">
            A workspace for useful, accountable team assistance.
          </p>
        )}
      </aside>
      <main>
        {loading ? (
          <Notice>Connecting to your deployment…</Notice>
        ) : error ? (
          <Notice>{error}</Notice>
        ) : !current ? (
          <Auth
            claim={!initialized}
            onDone={() => {
              void load();
              navigate(initialized ? "/admin" : "/setup");
            }}
          />
        ) : (
          <Routes>
            <Route path="/setup" element={<Setup />} />
            <Route path="/admin/operations" element={<Operations />} />
            <Route
              path="/admin/plugins"
              element={
                current.admin.operator ? (
                  chosen ? (
                    <Plugins key={chosen} request={api} workspaceId={chosen} />
                  ) : (
                    <Setup />
                  )
                ) : (
                  <Page title="Operator access required">
                    <p>Plugins can be managed by deployment operators.</p>
                  </Page>
                )
              }
            />
            <Route
              path="/admin/logs"
              element={
                current.admin.operator ? (
                  <RuntimeLogs request={api} />
                ) : (
                  <Page title="Operator access required">
                    <p>Runtime logs are available to deployment operators.</p>
                  </Page>
                )
              }
            />
            {navigation.map(([path]) => (
              <Route
                key={path}
                path={`/admin/${path}`}
                element={
                  chosen ? (
                    <WorkspacePage
                      key={`${chosen}:${path}`}
                      id={chosen}
                      resource={path ?? "overview"}
                    />
                  ) : (
                    <Setup />
                  )
                }
              />
            ))}
            <Route
              path="*"
              element={
                chosen ? (
                  <WorkspacePage id={chosen} resource="overview" />
                ) : current.admin.operator ? (
                  <Setup />
                ) : (
                  <Page title="Link your Telegram identity">
                    <p>
                      Ask your deployment operator to enroll your Telegram ID
                      and issue an identity verification link for this account.
                    </p>
                  </Page>
                )
              }
            />
          </Routes>
        )}
      </main>
    </div>
  );
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <BrowserRouter>
      <Shell />
    </BrowserRouter>,
  );
