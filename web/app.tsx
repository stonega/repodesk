import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import { Check, ChevronLeft, Refresh, Search } from "reicon-react";
import type { RunHistoryPage, RunSummary } from "../src/admin/run-history.ts";
import type {
  WorkflowCollection,
  WorkflowDetail,
} from "../src/admin/workflow-view.ts";
import type {
  ModelCapabilities,
  ModelLimits,
  ThinkingLevel,
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
import { settingsSchema } from "../src/domain.ts";
import { AccessRequests } from "./access-requests.tsx";
import { AuthNetwork } from "./auth-network.tsx";
import { DataDetails, DataTable } from "./data-details.tsx";
import {
  accountFields,
  chargeFields,
  deliveryFields,
  instructionFields,
  runFields,
  skillFields,
  workflowFields,
  workspaceOptions,
} from "./form-fields.ts";
import { GitHubConnection, GitHubSetup } from "./github.tsx";
import { GitHubMemberField } from "./github-member-field.tsx";
import { type ActionIcon, IconButton } from "./icon-button.tsx";
import { RuntimeLogs } from "./logs.tsx";
import { MemberRepositories } from "./member-repositories.tsx";
import { CreateModal, Modal, ModalActions, ModalPending } from "./modal.tsx";
import { ModelProvidersPanel } from "./model-providers.tsx";
import { Plugins } from "./plugins.tsx";
import { prefixFields, RecordForm } from "./record-form.tsx";
import { RunAttempts } from "./run-attempts.tsx";
import { Select } from "./select.tsx";
import { workspaceFields } from "./settings-fields.ts";
import { Sidebar } from "./sidebar.tsx";
import { Skeleton, SkeletonRows } from "./skeleton.tsx";
import { ThemeSwitch } from "./theme-switch.tsx";
import { ToastProvider, useToast } from "./toast.tsx";
import { Usage } from "./usage.tsx";
import { WorkflowSummary } from "./workflow-summary.tsx";
import "./style.css";
import { ApplicationUpdate } from "./application-update.tsx";
import { SiteDomain } from "./site-domain.tsx";

let csrf = "";
const sessionEvents = new EventTarget();
class ApiError extends Error {
  constructor(
    message: string,
    public issues: { path: string; message: string }[] = [],
    public status = 0,
  ) {
    super(message);
  }
}

async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    signal,
    headers: {
      "content-type": "application/json",
      ...(csrf ? { "x-csrf-token": csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 && path !== "/api/admin/auth/login") {
    csrf = "";
    sessionEvents.dispatchEvent(new Event("expired"));
  }
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status === 409 && data.error === "version_conflict"
        ? `${data.error}. Reload the current version and review your changes before saving again.`
        : response.status === 401
          ? path === "/api/admin/auth/login"
            ? "Invalid username or password."
            : "Your session expired. Sign in again."
          : data.error === "setup_incomplete"
            ? "Finish bot credentials, model configuration and Telegram reception before activating."
            : data.error === "workspace_and_skill_required"
              ? "Create a workspace with an enabled published skill before activating."
              : data.error === "https_origin_required"
                ? "Webhook mode requires a public HTTPS address. For local use, set TELEGRAM_TRANSPORT=polling and restart the app and worker."
                : data.issues?.length
                  ? data.issues
                      .map(
                        (issue: { path: string; message: string }) =>
                          `${issue.path}: ${issue.message}`,
                      )
                      .join(" ")
                  : data.error === "model_limits_required"
                    ? "Enter the custom model's context window and maximum output tokens."
                    : (data.error ?? "Request failed"),
      data.issues ?? [],
      response.status,
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
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    setRevision((n) => n + 1);
  }, []);
  useEffect(() => {
    void revision; // Reload explicitly invalidates the fetched resource.
    let live = true;
    setLoading(true);
    setError("");
    api<T>(resourcePath)
      .then((value) => {
        if (live) setData(value);
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [resourcePath, revision]);
  return { data, error, reload, loading };
}
function Pager({
  data,
  pageSize = 100,
  loading = false,
  alwaysShow = false,
}: {
  data: unknown;
  pageSize?: number;
  loading?: boolean;
  alwaysShow?: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const total = (data as { total?: number } | undefined)?.total ?? 0;
  const rawOffset = Number(params.get("offset"));
  const offset =
    Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  const goTo = (offset: number) => {
    const next = new URLSearchParams(params);
    next.set("offset", String(offset));
    setParams(next);
  };
  if (!alwaysShow && total <= pageSize && offset === 0) return null;
  return (
    <nav className="row pagination" aria-label="Pagination">
      <IconButton
        icon="previous"
        label="Previous page"
        type="button"
        disabled={loading || offset === 0}
        onClick={() => goTo(Math.max(0, offset - pageSize))}
      />
      <span>
        {loading ? (
          <Skeleton width="8rem" />
        ) : data ? (
          `${total > offset ? offset + 1 : 0}–${total > offset ? Math.min(offset + pageSize, total) : 0} of ${total}`
        ) : (
          "Page unavailable"
        )}
      </span>
      <IconButton
        icon="next"
        label="Next page"
        type="button"
        disabled={loading || offset + pageSize >= total}
        onClick={() => goTo(offset + pageSize)}
      />
    </nav>
  );
}
function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <p className="notice" role={error ? "alert" : "status"}>
      {children}
    </p>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: Every Field receives a labelable input, textarea, or dropdown trigger as its child.
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Action({
  resetKey,
  children,
  icon,
  type = "button",
  onClick,
  danger = false,
  disabled = false,
  loading = false,
  onConflict,
  onError,
}: {
  resetKey?: unknown;
  children: string;
  icon?: ActionIcon;
  type?: "button" | "submit";
  onClick: () => Promise<unknown>;
  danger?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onConflict?: () => void;
  onError?: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const setModalPending = useContext(ModalPending);
  useEffect(() => {
    if (resetKey !== undefined) setError("");
  }, [resetKey]);
  const perform = async () => {
    if (busy || loading) return;
    setBusy(true);
    setModalPending?.(true);
    setError("");
    onError?.("");
    try {
      await onClick();
    } catch (e) {
      if (onError) onError((e as Error).message);
      else setError((e as Error).message);
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
          busy={busy || loading}
          onClick={perform}
        />
      ) : (
        <button
          type={type}
          className={danger ? "danger" : ""}
          disabled={busy || loading || disabled}
          aria-busy={busy || loading}
          onClick={perform}
        >
          {busy || loading ? "Working…" : children}
        </button>
      )}
      {icon && (
        <span className="sr-only" aria-live="polite">
          {busy || loading ? `${children}: Working…` : ""}
        </span>
      )}
      {error && <Notice error>{error}</Notice>}
      {error.includes("version_conflict") && onConflict && (
        <button
          type="button"
          disabled={busy || loading}
          onClick={() => {
            onConflict();
            setError("");
          }}
        >
          Reload current version
        </button>
      )}
    </span>
  );
}
function Page({
  title,
  titleBadge,
  description,
  actions,
  children,
}: {
  title: string;
  titleBadge?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <div className="page-heading">
        <p className="eyebrow">REPODESK / TEAM OPERATIONS</p>
        <div className="page-title-row">
          <div className="page-title">
            <h1>{title}</h1>
            {titleBadge && <span className="pill">{titleBadge}</span>}
          </div>
          {actions && <div className="page-actions">{actions}</div>}
        </div>
        {description && <p className="muted">{description}</p>}
      </div>
      {children}
    </>
  );
}
function Auth({
  claim,
  onDone,
}: {
  claim: boolean;
  onDone: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError("");
    try {
      const result = await api<{ csrf: string }>(
        claim ? "/api/setup/claim" : "/api/admin/auth/login",
        "POST",
        values,
      );
      csrf = result.csrf;
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-content">
      <p className="eyebrow">
        {claim ? "FIRST RUN / ADMIN ACCOUNT" : "REPODESK / ADMIN ACCESS"}
      </p>
      <h1>{claim ? "Make this workspace yours" : "Welcome back"}</h1>
      <p className="auth-lede">
        {claim
          ? "Create the administrator account for this deployment. You can finish the rest of setup at your own pace."
          : "Sign in to manage your team assistant."}
      </p>
      <form className="auth-form" onSubmit={submit}>
        <Field label="Username">
          <input
            name="username"
            disabled={busy}
            required
            autoComplete="username"
            pattern="[a-zA-Z0-9_.-]{3,64}"
          />
        </Field>
        <Field label="Password">
          <input
            name="password"
            disabled={busy}
            type="password"
            minLength={12}
            maxLength={256}
            required
            autoComplete={claim ? "new-password" : "current-password"}
          />
        </Field>
        {error && <Notice error>{error}</Notice>}
        <button
          className="auth-submit"
          type="submit"
          disabled={busy}
          aria-busy={busy}
          aria-live="polite"
        >
          {busy && (
            <Refresh
              className="icon-spinning"
              size={18}
              weight="Outline"
              aria-hidden="true"
            />
          )}
          {busy
            ? claim
              ? "Creating administrator…"
              : "Signing in…"
            : claim
              ? "Create administrator"
              : "Sign in"}
        </button>
      </form>
    </div>
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
  modelLimits?: ModelLimits | null;
  modelCapabilities?: ModelCapabilities;
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
    chatModelConfigured?: boolean;
    skills: {
      id: string;
      name: string;
      enabled: boolean;
      published: boolean;
    }[];
    deleted: boolean;
  }[];
}
function Setup() {
  const { data, error, reload } = useData<Progress>("/api/setup/progress");
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const creatingWorkspace = params.get("new") === "1";
  const selected = params.get("workspace");
  const [completedWorkspace, setCompletedWorkspace] = useState<string | null>(
    null,
  );
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [credentialSaving, setCredentialSaving] = useState(false);
  useEffect(() => {
    const timer = setInterval(reload, 5000);
    return () => clearInterval(timer);
  }, [reload]);
  if (!data)
    return (
      <Page
        title={
          creatingWorkspace
            ? "Set up a new workspace"
            : "Set up your team assistant"
        }
        description="Create a workspace, choose your chat model, connect Telegram and set up GitHub."
      >
        {error ? (
          <Notice error>{error}</Notice>
        ) : (
          <>
            <nav className="setup-steps" aria-label="Setup steps">
              {["Workspace", "Model", "Telegram bot", "GitHub App"].map(
                (label, index) => (
                  <button
                    type="button"
                    className="setup-step"
                    disabled
                    key={label}
                  >
                    <span className="setup-step-number">{index + 1}</span>
                    <strong>{label}</strong>
                  </button>
                ),
              )}
            </nav>
            <section className="card" aria-busy="true">
              <SkeletonRows label="Setup details" />
            </section>
          </>
        )}
      </Page>
    );
  const workspace = creatingWorkspace
    ? undefined
    : selected
      ? data.workspaces.find((w) => w.id === selected && !w.deleted)
      : data.workspaces.find((w) => !w.deleted);
  const localTimeZone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const suggestedTimeZones = Array.from(
    new Set(
      [localTimeZone, workspace?.settings.timezone, "UTC"].filter(
        (zone): zone is string => !!zone,
      ),
    ),
  );
  const otherTimeZones = (Intl.supportedValuesOf?.("timeZone") ?? []).filter(
    (zone) => !suggestedTimeZones.includes(zone),
  );
  const steps = [
    { id: "workspace", label: "Workspace", complete: !!workspace },
    { id: "model", label: "Model", complete: !!workspace?.chatModelConfigured },
    { id: "telegram", label: "Telegram bot", complete: !!data.bot },
    { id: "github", label: "GitHub App", complete: false },
  ] as const;
  const requestedStep = creatingWorkspace ? "workspace" : params.get("step");
  const currentStep =
    steps.find((step) => step.id === requestedStep)?.id ??
    steps.find((step) => !step.complete)?.id ??
    "github";
  const currentIndex = steps.findIndex((step) => step.id === currentStep);
  const previousStep = steps[currentIndex - 1];
  const goToStep = (step: (typeof steps)[number]["id"]) => {
    const next = new URLSearchParams(params);
    next.set("step", step);
    setParams(next);
    window.scrollTo(0, 0);
  };
  return (
    <Page
      title={
        creatingWorkspace
          ? "Set up a new workspace"
          : "Set up your team assistant"
      }
      description="Create a workspace, choose your chat model, connect Telegram and set up GitHub."
    >
      <p className="setup-account-status">
        Setup · Step {currentIndex + 1} of {steps.length}
      </p>
      <nav className="setup-steps" aria-label="Setup steps">
        {steps.map((step, index) => (
          <button
            key={step.id}
            type="button"
            className={
              step.id === currentStep ? "setup-step current" : "setup-step"
            }
            aria-current={step.id === currentStep ? "step" : undefined}
            disabled={
              workspaceSaving ||
              credentialSaving ||
              !!completedWorkspace ||
              (creatingWorkspace && step.id !== "workspace")
            }
            onClick={() => goToStep(step.id)}
          >
            <span className="setup-step-number">{index + 1}</span>
            <span className="setup-step-copy">
              <strong>{step.label}</strong>
              <small>
                {step.complete
                  ? "Complete"
                  : step.id === currentStep
                    ? "In progress"
                    : "To do"}
              </small>
            </span>
          </button>
        ))}
      </nav>
      {currentStep === "workspace" && (
        <section className="card setup-card">
          <h2>Workspace</h2>
          <p className="muted">
            Create a space for your team. You can adjust budgets, retention, and
            other policies in the Overview team editor later.
          </p>
          {!creatingWorkspace && data.workspaces.some((w) => !w.deleted) && (
            <Field label="Workspace draft">
              <Select
                value={workspace?.id ?? ""}
                onChange={(e) => {
                  const next = new URLSearchParams(params);
                  next.set("workspace", e.target.value);
                  setParams(next);
                  setWorkspaceError("");
                }}
              >
                {data.workspaces
                  .filter((w) => !w.deleted)
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.settings.name}
                    </option>
                  ))}
              </Select>
            </Field>
          )}
          {workspace?.ownerVerified ? (
            <p>
              {workspace.settings.name} · {workspace.settings.timezone}
            </p>
          ) : (
            <form
              id="setup-workspace-form"
              key={workspace?.id ?? "new"}
              aria-busy={workspaceSaving}
              onSubmit={async (event) => {
                event.preventDefault();
                if (workspaceSaving) return;
                const values = new FormData(event.currentTarget);
                const name = String(values.get("name") ?? "").trim();
                const timezone = String(values.get("timezone") ?? "").trim();
                setWorkspaceSaving(true);
                setWorkspaceError("");
                try {
                  if (!workspace) {
                    const created = await api<{ id: string }>(
                      "/api/setup/workspaces",
                      "POST",
                      {
                        name,
                        timezone,
                      },
                    );
                    const next = new URLSearchParams(params);
                    next.delete("new");
                    next.set("workspace", created.id);
                    next.set("step", "model");
                    setParams(next);
                  } else if (
                    name !== workspace.settings.name ||
                    timezone !== workspace.settings.timezone
                  ) {
                    await api(`/api/setup/workspaces/${workspace.id}`, "PUT", {
                      version: workspace.version,
                      settings: { ...workspace.settings, name, timezone },
                    });
                  }
                  reload();
                  if (workspace) goToStep("model");
                } catch (error) {
                  setWorkspaceError(
                    error instanceof Error
                      ? error.message
                      : "Could not save workspace.",
                  );
                } finally {
                  setWorkspaceSaving(false);
                }
              }}
            >
              <Field label="Workspace name">
                <input
                  name="name"
                  required
                  maxLength={80}
                  disabled={workspaceSaving}
                  defaultValue={workspace?.settings.name ?? "My team"}
                  onChange={() => setWorkspaceError("")}
                />
              </Field>
              <Field label="Timezone">
                <Select
                  name="timezone"
                  required
                  disabled={workspaceSaving}
                  defaultValue={workspace?.settings.timezone ?? localTimeZone}
                  onChange={() => setWorkspaceError("")}
                >
                  <optgroup label="Suggested">
                    {suggestedTimeZones.map((zone) => (
                      <option key={zone} value={zone}>
                        {zone}
                      </option>
                    ))}
                  </optgroup>
                  {otherTimeZones.length > 0 && (
                    <optgroup label="All timezones">
                      {otherTimeZones.map((zone) => (
                        <option key={zone} value={zone}>
                          {zone}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </Select>
              </Field>
              {workspaceError && (
                <p role="alert" className="notice">
                  {workspaceError}
                </p>
              )}
            </form>
          )}
        </section>
      )}
      {currentStep === "model" &&
        (workspace ? (
          <ModelProvidersPanel
            request={api}
            workspaceId={workspace.id}
            legacyModel={data.model}
            onPending={setCredentialSaving}
            onContinue={() => {
              reload();
              goToStep("telegram");
            }}
          />
        ) : (
          <Notice>Save a workspace before choosing a model.</Notice>
        ))}
      {currentStep === "telegram" && (
        <section className="card setup-card">
          <h2>Connect Telegram</h2>
          <p className="muted">
            Create a dedicated bot with BotFather. Saving its token calls
            Telegram to verify its identity.
          </p>
          <TelegramCredentialForm
            progress={data}
            reload={reload}
            onContinue={() => goToStep("github")}
            saving={credentialSaving}
            setSaving={setCredentialSaving}
          />
        </section>
      )}
      {currentStep === "github" && (
        <section className="card setup-card">
          <h2>Connect GitHub</h2>
          <p className="muted">
            Continue on GitHub to authorize your account and choose the
            repositories this workspace can access.
          </p>
          {workspace ? (
            <GitHubSetup
              request={api}
              workspaceId={workspace.id}
              onConnected={() => setCompletedWorkspace(workspace.id)}
            />
          ) : (
            <Notice>Save a workspace before setting up GitHub.</Notice>
          )}
        </section>
      )}
      <div className="setup-navigation">
        {creatingWorkspace && (
          <button
            type="button"
            className="secondary"
            disabled={workspaceSaving}
            onClick={() => navigate("/admin")}
          >
            Cancel
          </button>
        )}
        {previousStep && (
          <button
            type="button"
            className="secondary"
            disabled={
              workspaceSaving || credentialSaving || !!completedWorkspace
            }
            onClick={() => goToStep(previousStep.id)}
          >
            Back
          </button>
        )}
        {currentStep === "workspace" && !workspace?.ownerVerified ? (
          <button
            type="submit"
            form="setup-workspace-form"
            disabled={workspaceSaving}
            aria-busy={workspaceSaving}
          >
            {workspaceSaving ? "Saving…" : "Continue to Model"}
          </button>
        ) : currentStep === "model" ? (
          <button
            type="submit"
            form="setup-model-form"
            disabled={credentialSaving || !workspace}
            aria-busy={credentialSaving}
          >
            {credentialSaving ? "Saving…" : "Continue to Telegram"}
          </button>
        ) : currentStep === "telegram" ? (
          <button
            type="submit"
            form={`setup-${currentStep}-form`}
            disabled={credentialSaving}
            aria-busy={credentialSaving}
          >
            {credentialSaving ? "Saving…" : "Continue to GitHub App"}
          </button>
        ) : currentStep === "github" && workspace ? (
          <button
            type="button"
            className="secondary"
            onClick={() => navigate(`/admin?workspace=${workspace.id}`)}
          >
            Finish later in admin
          </button>
        ) : null}
      </div>
      {completedWorkspace && (
        <SetupCelebration
          onStart={() =>
            navigate(`/admin?workspace=${completedWorkspace}`, {
              replace: true,
            })
          }
        />
      )}
    </Page>
  );
}
const confettiPieces = Array.from({ length: 32 }, (_, index) => ({
  id: `confetti-${index + 1}`,
  left: `${(index * 37) % 100}%`,
  color: ["#1d594c", "#84ae96", "#d8b762", "#e8a073", "#b6d1b2"][index % 5],
  delay: `${(index * 73) % 650}ms`,
  duration: `${1400 + (index % 5) * 170}ms`,
}));
function SetupCelebration({ onStart }: { onStart: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    element?.querySelector("button")?.focus();
    return () => element?.close();
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className="setup-celebration"
      aria-labelledby="setup-welcome-title"
      aria-describedby="setup-welcome-description"
      onCancel={(event) => event.preventDefault()}
    >
      <div className="setup-confetti" aria-hidden="true">
        {confettiPieces.map((piece) => (
          <span
            key={piece.id}
            style={{
              left: piece.left,
              backgroundColor: piece.color,
              animationDelay: piece.delay,
              animationDuration: piece.duration,
            }}
          />
        ))}
      </div>
      <div className="setup-celebration-card">
        <span className="setup-celebration-mark" aria-hidden="true">
          <Check size={28} weight="Outline" color="currentColor" />
        </span>
        <h2 id="setup-welcome-title">Welcome to RepoDesk</h2>
        <p id="setup-welcome-description">
          Your workspace is ready. Configure your model and activate the bot in
          the admin panel.
        </p>
        <button type="button" onClick={onStart}>
          Get started
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
function ModelSettings({ workspaceId }: { workspaceId: string }) {
  const { data, error, reload, loading } = useData<Progress>(
    "/api/setup/progress",
  );
  const [identity, setIdentity] = useState<{ url: string; command: string }>();
  useEffect(() => {
    const timer = setInterval(reload, 5000);
    return () => clearInterval(timer);
  }, [reload]);
  if (!data)
    return (
      <Page
        title="Model settings"
        description="Connect your model provider, then activate the assistant when its receiver and skills are ready."
      >
        {error ? (
          <Notice error>{error}</Notice>
        ) : (
          <ModelProvidersPanel request={api} workspaceId={workspaceId} />
        )}
      </Page>
    );
  const workspace = data.workspaces.find((w) => w.id === workspaceId);
  const missing = [
    !workspace && "Create a workspace in Setup.",
    !data.credentials.bot && "Save a Telegram bot token in Setup.",
    !data.credentials.model &&
      !workspace?.chatModelConfigured &&
      "Choose a provider and chat model.",
    !workspace?.chatModelConfigured &&
      !data.modelCapabilities &&
      "Configure the model context window and maximum output.",
    !data.receiver.ready &&
      (data.telegramTransport === "polling"
        ? "Wait for the polling worker to connect."
        : "Register the Telegram webhook."),
    workspace &&
      !workspace.skills.some((s) => s.enabled && s.published) &&
      "Enable a published skill.",
  ].filter((item): item is string => typeof item === "string");
  return (
    <Page
      title="Model settings"
      description="Connect your model provider, then activate the assistant when its receiver and skills are ready."
    >
      <ModelProvidersPanel
        key={workspaceId}
        request={api}
        workspaceId={workspaceId}
        onSaved={reload}
        legacyModel={data.model}
      />
      <section className="card" aria-label="Activation">
        <h2>Activate the bot</h2>
        <p>
          {data.telegramTransport === "polling" ? "Polling" : "Webhook"}:{" "}
          {data.receiver.ready ? "ready" : "pending"}
        </p>
        {data.telegramTransport === "webhook" && !data.receiver.ready && (
          <Action
            disabled={!data.credentials.bot}
            onClick={async () => {
              await api("/api/setup/webhook", "POST", {});
              reload();
            }}
          >
            Register Telegram webhook
          </Action>
        )}
        {data.telegramTransport === "polling" && data.receiver.error && (
          <Notice>
            {data.receiver.error === "polling_webhook_conflict"
              ? "This bot already has a webhook. Stop the other deployment and remove its webhook before using polling."
              : data.receiver.error === "telegram_polling_conflict"
                ? "Another receiver is using this bot. Stop it before retrying."
                : data.receiver.error === "telegram_unauthorized"
                  ? "Telegram rejected the saved bot token. Save a valid token in Setup."
                  : "Polling is not ready. Check the worker and its Telegram connection; it will retry automatically."}
          </Notice>
        )}
        <p>
          Enabled skills:{" "}
          {workspace?.skills
            .filter((s) => s.enabled && s.published)
            .map((s) => s.name)
            .join(", ") || "none"}
          .
        </p>
        {!data.active && missing.length > 0 && (
          <ul aria-label="Remaining activation requirements">
            {missing.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
        {!data.active && (
          <Action
            disabled={missing.length > 0}
            onClick={async () => {
              await api("/api/setup/activate", "POST", {});
              reload();
            }}
          >
            Activate bot
          </Action>
        )}
        {data.active && (
          <Notice>
            Active. Share the access link below and approve people who request
            access. Others cannot use the bot.
          </Notice>
        )}
        {data.active && workspace && <SetupAccess workspaceId={workspace.id} />}
        {data.active && workspace && !workspace.ownerVerified && (
          <details className="setup-advanced">
            <summary>Link my Telegram account (optional)</summary>
            <p className="muted">
              Link your personal Telegram account if you want owner controls in
              Telegram. It is not required for activation or web access.
            </p>
            <Action
              disabled={!data.receiver.ready}
              onClick={async () =>
                setIdentity(
                  await api(`/api/setup/identity/${workspace.id}`, "POST", {}),
                )
              }
            >
              Generate Telegram link
            </Action>
            {identity && (
              <Notice>
                <a href={identity.url} target="_blank" rel="noreferrer">
                  Link account in Telegram
                </a>
                <br />
                {identity.command}
                <br />
                Expires in 15 minutes. Sign in again after linking.
              </Notice>
            )}
          </details>
        )}
        {error && (
          <Action loading={loading} onClick={async () => reload()}>
            Try again
          </Action>
        )}
      </section>
    </Page>
  );
}
type SetupAccessData = {
  version: number;
  requestUrl: string | null;
  members: { id: string; role: string }[];
  requests: { id: string; actor: string; username?: string; name?: string }[];
};
function SetupAccess({ workspaceId }: { workspaceId: string }) {
  const path = `/api/setup/workspaces/${workspaceId}/access`;
  const { data, error, reload, loading } = useData<SetupAccessData>(path);
  const [actor, setActor] = useState("");
  useEffect(() => {
    const timer = setInterval(reload, 5000);
    return () => clearInterval(timer);
  }, [reload]);
  return (
    <div className="setup-access">
      <h3>Telegram access</h3>
      <p className="muted">
        Share the request link with teammates and approve them here, or add a
        known Telegram user ID directly. All active members can use the bot.
      </p>
      {error && <Notice error>{error}</Notice>}
      {data?.requestUrl && (
        <Field label="Request access link">
          <input
            readOnly
            value={data.requestUrl}
            onFocus={(e) => e.target.select()}
          />
        </Field>
      )}
      {data && (
        <>
          <Field label="Telegram user ID">
            <input
              type="text"
              inputMode="numeric"
              pattern="[1-9][0-9]{0,15}"
              value={actor}
              onChange={(event) => setActor(event.target.value)}
              placeholder="Numeric ID"
            />
          </Field>
          <Action
            disabled={!/^[1-9]\d{0,15}$/.test(actor) || loading}
            onConflict={reload}
            onClick={async () => {
              await api(path, "POST", { actor, version: data.version });
              setActor("");
              reload();
            }}
          >
            Add member
          </Action>
          <h4>Pending requests</h4>
          {data.requests.length ? (
            <ul className="setup-access-list">
              {data.requests.map((request) => (
                <li key={request.id}>
                  <span>
                    {request.name || request.username
                      ? `${request.name || request.username} · ${request.actor}`
                      : request.actor}
                  </span>
                  <div className="row">
                    {(["approved", "rejected"] as const).map((decision) => (
                      <Action
                        key={decision}
                        onConflict={reload}
                        onClick={async () => {
                          await api(
                            `${path}-requests/${request.id}/decision`,
                            "POST",
                            { decision, version: data.version },
                          );
                          reload();
                        }}
                      >
                        {decision === "approved" ? "Approve" : "Reject"}
                      </Action>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No pending requests.</p>
          )}
          <h4>Active members</h4>
          {data.members.length ? (
            <ul className="setup-access-list">
              {data.members.map((member) => (
                <li key={member.id}>
                  <span>
                    {member.id} · {member.role}
                  </span>
                  {member.role !== "owner" && (
                    <Action
                      onConflict={reload}
                      onClick={async () => {
                        await api(`${path}/${member.id}`, "DELETE", {
                          version: data.version,
                        });
                        reload();
                      }}
                    >
                      Revoke
                    </Action>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No one has access yet.</p>
          )}
        </>
      )}
    </div>
  );
}
function TelegramCredentialForm({
  progress: p,
  reload,
  onContinue,
  saving,
  setSaving,
}: {
  progress: Progress;
  reload: () => void;
  onContinue: () => void;
  saving: boolean;
  setSaving: (saving: boolean) => void;
}) {
  const [bot, setBot] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      id="setup-telegram-form"
      aria-busy={saving}
      onSubmit={async (event) => {
        event.preventDefault();
        if (saving) return;
        setError("");
        if (!bot.trim() && !p.credentials.bot) {
          setError("Enter a bot token to continue.");
          return;
        }
        setSaving(true);
        try {
          if (bot.trim()) {
            await api("/api/admin/operator/credentials", "PUT", {
              version: p.version,
              botToken: bot,
            });
            setBot("");
            reload();
          }
          onContinue();
        } catch (cause) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not save bot token.",
          );
        } finally {
          setSaving(false);
        }
      }}
    >
      <Field
        label={`Bot token · ${p.credentials.bot ? "configured" : "missing"}`}
      >
        <input
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={bot}
          onChange={(e) => {
            setBot(e.target.value);
            setError("");
          }}
          placeholder={
            p.credentials.bot
              ? "Leave blank to retain"
              : "Paste your BotFather token"
          }
        />
      </Field>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
    </form>
  );
}
function WorkspacePage({
  id,
  resource,
  admin,
}: {
  id: string;
  resource: string;
  admin: Session["admin"];
}) {
  if (resource === "usage") return <Usage id={id} request={api} />;
  if (resource === "settings") return <SettingsPage key={id} id={id} />;
  if (resource === "skills") return <SkillsPage id={id} />;
  if (resource === "workflows") return <WorkflowsPage id={id} />;
  if (resource === "instructions") return <InstructionsPage id={id} />;
  if (resource === "runs") return <RunsPage key={id} id={id} />;
  if (resource === "members") return <MembersPage id={id} />;
  if (resource === "chats") return <ChatsPage id={id} />;
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
function ReadPage({
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
  const counts = data?.counts ?? {
    members: undefined,
    runs: undefined,
    workflows: undefined,
    ...(admin.operator && !admin.telegramId ? { codingTasks: undefined } : {}),
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
function TelegramBotDialog({
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
              Saving a token turns off the bot until Telegram reception is ready
              and you reactivate it in Model settings.
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
function SettingsPage({ id }: { id: string }) {
  const { data, error, reload, loading } = useData<{
    version: number;
    settings: Settings;
  }>(`/api/admin/workspaces/${id}/settings`);
  const [current, setCurrent] = useState<typeof data>();
  const [confirming, setConfirming] = useState(false);
  const notify = useToast();
  useEffect(() => {
    if (data) setCurrent(data);
  }, [data]);
  const paused = current?.settings.paused;
  const action = paused ? "Resume workspace" : "Pause workspace";
  return (
    <Page
      title="Workspace settings"
      description="Pause or resume work in this workspace."
      actions={
        error && (
          <Action loading={loading} onClick={async () => reload()}>
            Try again
          </Action>
        )
      }
    >
      {error && <Notice error>{error}</Notice>}
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
    return `$${String(value)}`;
  const units: Partial<Record<keyof Settings, string>> = {
    maxTurns: "calls",
    retentionDays: "days",
    missedRunMinutes: "minutes",
  };
  const unit = units[key];
  return unit ? `${value} ${unit}` : String(value);
}
function WorkspaceSettingsEditor({
  id,
  current,
  onClose,
  onConflict,
  onSaved,
}: {
  id: string;
  current: { version: number; settings: Settings };
  onClose: () => void;
  onConflict: () => void;
  onSaved: (updated: { version: number; settings: Settings }) => void;
}) {
  const [draft, setDraft] = useState<Settings>(current.settings);
  const [issues, setIssues] = useState<Record<string, string>>({});
  return (
    <Modal title="Edit team configuration" onClose={onClose}>
      <form onSubmit={(event) => event.preventDefault()}>
        {workspaceFields.map((field) => {
          const fieldId = `settings-${field.key}`;
          const value = draft[field.key];
          const issue = issues[field.key];
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
              <input
                id={fieldId}
                type={
                  typeof value === "boolean"
                    ? "checkbox"
                    : typeof value === "number"
                      ? "number"
                      : "text"
                }
                min={field.min}
                max={field.max}
                step={field.step}
                checked={typeof value === "boolean" ? value : undefined}
                value={
                  typeof value === "boolean"
                    ? undefined
                    : Number.isNaN(value)
                      ? ""
                      : String(value)
                }
                aria-invalid={!!issue}
                aria-describedby={`${fieldId}-help${issue ? ` ${fieldId}-error` : ""}`}
                onChange={(event) => {
                  const next =
                    typeof value === "boolean"
                      ? event.target.checked
                      : typeof value === "number"
                        ? event.target.value === ""
                          ? Number.NaN
                          : Number(event.target.value)
                        : event.target.value;
                  setDraft({ ...draft, [field.key]: next });
                  setIssues((previous) => ({ ...previous, [field.key]: "" }));
                }}
              />
              <small id={`${fieldId}-help`}>{field.help}</small>
              {issue && (
                <small id={`${fieldId}-error`} role="alert">
                  {issue}
                </small>
              )}
            </div>
          );
        })}
        <ModalActions>
          <Action
            type="submit"
            resetKey={draft}
            onConflict={onConflict}
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
interface MembersData {
  version: number;
  items: Member[];
  total: number;
}
interface MemberDraft {
  id: string;
  role: string;
  active: boolean;
  githubId: string;
  githubAccount?: Member["githubAccount"];
  github?: Member["github"];
  githubChanged: boolean;
  githubRevision?: number;
}
function MembersPage({ id }: { id: string }) {
  const [search, setSearch] = useState("");
  const [params, setParams] = useSearchParams();
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const { data, error, reload, loading } = useData<MembersData>(
    `/api/admin/workspaces/${id}/members?offset=${offset}&search=${encodeURIComponent(search)}`,
  );
  const rows = data?.items ?? [];
  const [member, setMember] = useState<MemberDraft>({
    id: "",
    role: "member",
    active: true,
    githubId: "",
    githubChanged: false,
  });
  const [open, setOpen] = useState(false);
  const [editingMember, setEditingMember] = useState(false);
  return (
    <Page
      title="Members & access"
      description="All active workspace members can use the bot. Manage membership, roles and access requests here."
      actions={
        <>
          {error && (
            <Action loading={loading} onClick={async () => reload()}>
              Try again
            </Action>
          )}
          <IconButton
            icon="add"
            label="Add member"
            showLabel
            disabled={!data || loading}
            onClick={() => {
              setMember({
                id: "",
                role: "member",
                active: true,
                githubId: "",
                githubChanged: false,
              });
              setEditingMember(false);
              setOpen(true);
            }}
          />
        </>
      }
    >
      {error && <Notice error>{error}</Notice>}
      <section className="card" aria-label="Workspace members">
        <h2>Members</h2>
        <Field label="Search members by name, username or ID">
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              const next = new URLSearchParams(params);
              next.set("offset", "0");
              setParams(next);
            }}
          />
        </Field>
        <p className="muted">
          Telegram names update when people interact with the bot. Users without
          a username or known profile are identified by their Telegram ID.
        </p>
        <Pager data={data} />
        <section
          className="data-table-scroll"
          aria-label="Member access table"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll the wide member table.
          tabIndex={0}
        >
          <table className="member-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Membership</th>
                <th>GitHub</th>
                <th>Access</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const access = m.active ? "Allowed" : "Inactive";
                return (
                  <tr key={m.id}>
                    <td>
                      <strong>
                        {m.name ||
                          (m.username ? `@${m.username}` : "Telegram user")}
                      </strong>
                      {m.username && m.name && <div>@{m.username}</div>}
                      <div className="muted">ID: {m.id}</div>
                    </td>
                    <td>{m.role}</td>
                    <td>{m.active ? "Active" : "Removed"}</td>
                    <td className="github-access">
                      {m.github ? (
                        <>
                          <a
                            href={`https://github.com/${m.github.login}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <strong>{m.github.login}</strong>
                          </a>
                          <div className="muted">
                            {m.github.status} · Synced{" "}
                            {new Date(m.github.syncedAt).toLocaleString()}
                          </div>
                          <MemberRepositories
                            key={m.github.id}
                            login={m.github.login}
                            repositories={m.github.repositories}
                          />
                        </>
                      ) : m.githubAccount ? (
                        <>
                          <a
                            href={`https://github.com/${m.githubAccount.login}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <strong>{m.githubAccount.login}</strong>
                          </a>
                          <div className="muted">Verification pending</div>
                        </>
                      ) : (
                        <span className="muted">Not linked</span>
                      )}
                    </td>
                    <td>
                      <span
                        className={`pill ${access === "Allowed" ? "good" : ""}`}
                      >
                        {access}
                      </span>
                    </td>
                    <td>
                      {m.role !== "owner" && (
                        <IconButton
                          icon="edit"
                          label={`Edit member ${m.id}`}
                          disabled={loading}
                          onClick={() => {
                            setMember({
                              id: m.id,
                              role: m.role,
                              active: m.active,
                              githubId: String(
                                m.github?.id ?? m.githubAccount?.id ?? "",
                              ),
                              githubAccount: m.githubAccount,
                              github: m.github,
                              githubChanged: false,
                            });
                            setEditingMember(true);
                            setOpen(true);
                          }}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
        {data && rows.length === 0 && <p>No members match your search.</p>}
      </section>
      <AccessRequests
        key={id}
        id={id}
        request={api}
        onChange={reload}
        refreshKey={data}
      />
      {open && (
        <Modal
          title={editingMember ? "Edit member" : "Add member"}
          onClose={() => setOpen(false)}
        >
          <Field label="Telegram user ID">
            <input
              value={member.id}
              readOnly={editingMember}
              onChange={(e) => setMember({ ...member, id: e.target.value })}
            />
          </Field>
          <p className="muted member-id-help">
            Usernames are received from Telegram; a numeric user ID is required
            for membership.
          </p>
          <GitHubMemberField
            workspaceId={id}
            request={api}
            account={member.github ?? member.githubAccount}
            verified={!!member.github}
            value={member.githubId}
            onChange={(githubId, githubRevision) =>
              setMember((current) => ({
                ...current,
                githubId,
                githubRevision,
                githubChanged: true,
              }))
            }
          />
          <Field label="Role">
            <Select
              aria-label="Role"
              value={member.role}
              onChange={(e) => setMember({ ...member, role: e.target.value })}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </Select>
          </Field>
          <label className="member-toggle-row">
            <span>Active membership</span>
            <input
              className="member-toggle-input"
              type="checkbox"
              role="switch"
              aria-checked={member.active}
              checked={member.active}
              onChange={(e) =>
                setMember({ ...member, active: e.target.checked })
              }
            />
          </label>
          <ModalActions>
            <Action
              onClick={async () => {
                await api(`/api/admin/workspaces/${id}/members`, "POST", {
                  id: member.id,
                  role: member.role,
                  active: member.active,
                  ...(member.githubChanged
                    ? {
                        githubId: member.githubId
                          ? Number(member.githubId)
                          : null,
                        githubRevision: member.githubRevision,
                      }
                    : {}),
                  version: data?.version,
                });
                reload();
                setOpen(false);
              }}
            >
              Save membership
            </Action>
          </ModalActions>
        </Modal>
      )}
    </Page>
  );
}
function ChatsPage({ id }: { id: string }) {
  const { data, error, reload, loading } = useData<{ items: Chat[] }>(
    `/api/admin/workspaces/${id}/chats`,
  );
  return (
    <Page
      title="Group access"
      description="One explicitly connected group per workspace. Send /linktoken privately to the bot, then /link TOKEN in a group where you are an admin."
    >
      {error && <Notice error>{error}</Notice>}
      <Pager data={data} />
      {data?.items.map((chat) => (
        <section className="card" key={chat.id}>
          <h2>{chat.title || chat.id}</h2>
          {chat.title && <p className="muted">Group ID: {chat.id}</p>}
          <p>
            {chat.active ? "Linked" : "Inactive"} ·{" "}
            {chat.visibleAll
              ? "Receives group messages"
              : "Directed visibility"}{" "}
            · Collection: {chat.collection ? "enabled" : "directed only"}
          </p>
          <p>
            Opt-in collection may include received messages from people who are
            not workspace members. Group replies are visible to everyone in the
            group. Old history is unavailable.
          </p>
          <div className="row">
            <Action
              loading={loading}
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
  refreshKey,
}: {
  id: string;
  reloadParent?: () => void;
  refreshKey?: unknown;
}) {
  const { data, error, reload, loading } = useData<{ items: Approval[] }>(
    `/api/admin/workspaces/${id}/approvals`,
  );
  useEffect(() => {
    if (refreshKey !== undefined) reload();
  }, [refreshKey, reload]);
  return (
    <section className="card">
      <h2>Awaiting your approval</h2>
      {error && <Notice error>{error}</Notice>}
      {error && (
        <Action loading={loading} onClick={async () => reload()}>
          Try again
        </Action>
      )}
      {data?.items.length === 0 && <p>No pending proposals.</p>}
      {data?.items.map((a) => (
        <article key={a.id}>
          <h3>
            {a.kind} · v{a.version}
          </h3>
          <p>Expires {new Date(a.expiresAt).toLocaleString()}</p>
          <DataDetails value={a.payload} />
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
function WorkflowDetailRoute({ id }: { id: string }) {
  const { workflowId = "" } = useParams();
  return (
    <WorkflowsPage key={id + workflowId} id={id} workflowId={workflowId} />
  );
}
function WorkflowsPage({
  id,
  workflowId,
}: {
  id: string;
  workflowId?: string;
}) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const backParams = new URLSearchParams(params);
  backParams.set("workspace", id);
  const listUrl = `/admin/workflows?${backParams.toString()}`;
  const detailUrl = (workflow: string) =>
    `/admin/workflows/${encodeURIComponent(workflow)}?${backParams.toString()}`;
  const {
    data: response,
    error,
    reload,
    loading,
  } = useData<WorkflowCollection | WorkflowDetail>(
    `/api/admin/workspaces/${id}/workflows${workflowId ? `/${encodeURIComponent(workflowId)}` : ""}`,
  );
  const data: WorkflowCollection | undefined =
    !error && response
      ? "workflow" in response
        ? response.mode === "member"
          ? { ...response, items: [response.workflow], total: 1 }
          : { ...response, items: [response.workflow], total: 1 }
        : response
      : undefined;
  const memberData = data?.mode === "member" ? data : undefined;
  const repositorySources = memberData?.repositorySources ?? {
    revision: 0,
    repositories: [],
  };
  const operatorData = data?.mode === "operator" ? data : undefined;
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
      title={workflowId ? "Workflow details" : "Scheduled workflows"}
      description="Daily and weekly schedules use the displayed timezone. Late runs over five minutes are skipped; daylight-saving gaps are skipped and repeated times run once."
      actions={
        <>
          {memberData && !workflowId && (
            <IconButton
              icon="add"
              label="Add workflow"
              onClick={() => setCreating(true)}
            />
          )}
          {error && (
            <Action loading={loading} onClick={async () => reload()}>
              Try again
            </Action>
          )}
        </>
      }
    >
      {error && (
        <Notice error>
          {workflowId && error === "not_found"
            ? "Workflow not found or no longer available."
            : error}
        </Notice>
      )}
      {workflowId ? (
        <p>
          <Link className="page-back-link" to={listUrl}>
            <ChevronLeft
              size={18}
              weight="Outline"
              color="currentColor"
              aria-hidden="true"
            />
            Back to Workflows
          </Link>
        </p>
      ) : (
        <Pager data={data} />
      )}
      {loading && !data && <SkeletonRows label="Workflows" />}
      {operatorData && (
        <p className="muted">
          Workspace schedule details are read-only here. Link your Telegram
          identity in <NavLink to="/setup">Setup</NavLink> to manage workflows.
        </p>
      )}
      {data?.total === 0 && (
        <section className="card">No scheduled workflows yet.</section>
      )}
      {operatorData?.items.map((f) => (
        <section className="card workflow-card" key={f.id}>
          <div className="row">
            <h2>
              {workflowId ? (
                f.name
              ) : (
                <Link className="workflow-title-link" to={detailUrl(f.id)}>
                  {f.name}
                </Link>
              )}
            </h2>
            <span className="pill">{f.status}</span>
          </div>
          <WorkflowSummary workflow={f} detail={!!workflowId} />
        </section>
      ))}
      {memberData?.items.map((f) => (
        <section className="card workflow-card" key={f.id}>
          <div className="row">
            <h2>
              {workflowId ? (
                f.spec.name
              ) : (
                <Link className="workflow-title-link" to={detailUrl(f.id)}>
                  {f.spec.name}
                </Link>
              )}
            </h2>
            <span className="pill">{f.status}</span>
          </div>
          <WorkflowSummary
            workflow={{
              ...f,
              name: f.spec.name,
              recurrence: f.spec.recurrence,
              budgetUsd: f.spec.budgetUsd,
            }}
            detail={!!workflowId}
          />
          {workflowId && (
            <>
              <h3>Task</h3>
              <p className="workflow-text">{f.spec.task}</p>
              <h3>Output format</h3>
              <p className="workflow-text">
                {f.spec.format || "No format specified."}
              </p>
              <dl className="workflow-summary">
                <div>
                  <dt>Source / destination (Telegram)</dt>
                  <dd>
                    {f.spec.chatId}
                    <small>Topic {f.spec.topicId}</small>
                  </dd>
                </div>
                <div>
                  <dt>Context window</dt>
                  <dd>{f.spec.windowDays} days</dd>
                </div>
                <div>
                  <dt>Skill</dt>
                  <dd>
                    {skills.data?.items.find(
                      (skill) => skill.id === f.spec.skillId,
                    )?.draft.name ?? f.spec.skillId}
                    <small>Pinned version {f.skillVersion}</small>
                  </dd>
                </div>
              </dl>
            </>
          )}
          {f.spec.github && (
            <p>
              Repositories:{" "}
              {f.spec.github.repositoryIds
                .map(
                  (repoId) =>
                    repositorySources.repositories.find(
                      (repo) => repo.id === repoId,
                    )?.full_name ?? `Unavailable repository ${repoId}`,
                )
                .join(", ")}
            </p>
          )}
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
                  if (workflowId && action === "delete") navigate(listUrl);
                  else reload();
                }}
              >
                {action}
              </Action>
            ))}
          </div>
        </section>
      ))}
      {memberData && (creating || editing) && (
        <Modal
          title={editing ? `Edit ${editing.spec.name}` : "Propose a schedule"}
          onClose={closeEditor}
        >
          <p>
            Use a linked group ID or your verified Telegram ID for private
            delivery. Editing requires a new approval. Unsupported recurrence
            needs clarification.
          </p>
          <RecordForm
            fields={prefixFields(
              editing ? "spec." : "",
              workflowFields(skills.data?.items ?? [], [
                ...repositorySources.repositories,
                ...(editing?.spec.github?.repositoryIds
                  .filter(
                    (repoId) =>
                      !repositorySources.repositories.some(
                        (repo) => repo.id === repoId,
                      ),
                  )
                  .map((repoId) => ({
                    id: repoId,
                    full_name: `Unavailable repository ${repoId}`,
                  })) ?? []),
              ]),
            )}
            value={
              editing
                ? {
                    version: editing.version,
                    spec: {
                      ...editing.spec,
                      repositoryIds: editing.spec.github?.repositoryIds ?? [],
                    },
                  }
                : { ...initial, repositoryIds: [] }
            }
            label="Preview approval proposal"
            save={async (value) => {
              const record = value as Record<string, unknown>;
              const spec = (editing ? record.spec : record) as Record<
                string,
                unknown
              >;
              const repositoryIds = spec.repositoryIds as number[];
              delete spec.repositoryIds;
              if (repositoryIds?.length)
                spec.github = {
                  revision: repositorySources.revision,
                  repositoryIds,
                };
              else delete spec.github;
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
          <DataDetails value={proposal} />
        </section>
      )}
      {memberData && (
        <ApprovalList id={id} reloadParent={reload} refreshKey={data} />
      )}
    </Page>
  );
}
function SkillCardHeader({
  skill: s,
  onEdit,
  onAction,
}: {
  skill: Skill;
  onEdit: () => void;
  onAction: (action: "enable" | "disable" | "archive") => Promise<void>;
}) {
  const [error, setError] = useState("");
  return (
    <>
      <div className="skill-card-header">
        <div className="skill-card-title">
          <h2>{s.draft.name}</h2>
          <span className="pill">
            {s.archived ? "Archived" : s.enabled ? "Enabled" : "Disabled"}
          </span>
        </div>
        <div className="skill-card-controls">
          <IconButton
            icon="edit"
            label="Edit draft"
            type="button"
            onClick={onEdit}
          />
          {([s.enabled ? "disable" : "enable", "archive"] as const).map(
            (action) => (
              <Action
                icon={
                  action === "archive"
                    ? "archive"
                    : action === "disable"
                      ? "pause"
                      : "play"
                }
                key={action}
                danger={action === "archive"}
                disabled={
                  s.archived || (action === "enable" && !s.published.length)
                }
                onError={(message) =>
                  setError(
                    message === "publish_first"
                      ? "Only published, unarchived skills can be enabled. Reload the page to check this skill’s current status."
                      : message,
                  )
                }
                onClick={async () => {
                  await onAction(action);
                }}
              >
                {action}
              </Action>
            ),
          )}
        </div>
      </div>

      {s.archived ? (
        <p className="muted">
          Archived skills cannot be enabled. Create or import a new skill to
          reuse these instructions.
        </p>
      ) : !s.enabled && !s.published.length ? (
        <p className="muted">
          Review the instructions and choose Publish draft below, then enable
          this skill.
        </p>
      ) : null}
      {error && <Notice error>{error}</Notice>}
    </>
  );
}

function SkillsPage({ id }: { id: string }) {
  const { data, error, reload } = useData<{
    items: (Skill & { dependents: unknown[] })[];
    total: number;
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
  const [rollbackVersions, setRollbackVersions] = useState<
    Record<string, number>
  >({});
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const searchInput = useRef<HTMLInputElement>(null);
  const searchTerms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visibleSkills = data?.items.filter((skill) => {
    const text =
      `${skill.draft.name} ${skill.draft.slug} ${skill.draft.description}`.toLowerCase();
    return (
      searchTerms.every((term) => text.includes(term)) &&
      (filter === "all" || (filter === "enabled") === skill.enabled)
    );
  });
  const resetFilters = () => {
    setSearch("");
    setFilter("all");
    searchInput.current?.focus();
  };
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
            icon="import"
            label="Import skill"
            onClick={() => {
              setImported("");
              setImporting(true);
            }}
          />
          <IconButton
            icon="add"
            label="Add skill"
            showLabel
            onClick={() => setCreating(true)}
          />
        </>
      }
    >
      {error && <Notice error>{error}</Notice>}
      <Pager data={data} />
      <div className="skill-catalog-toolbar">
        <span className="muted skill-catalog-count" role="status">
          {data &&
            `${visibleSkills?.length} of ${data.items.length} skills${data.total > 100 ? " on this page" : ""}`}
        </span>
        <div className="skill-catalog-controls">
          <div className="skill-catalog-search">
            <Search size={20} aria-hidden="true" focusable="false" />
            <input
              ref={searchInput}
              type="search"
              aria-label="Search skills"
              placeholder="Search skills…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <IconButton
                icon="close"
                label="Clear search"
                onClick={() => {
                  setSearch("");
                  searchInput.current?.focus();
                }}
              />
            )}
          </div>
          <Select
            aria-label="Skill state"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All states</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </Select>
        </div>
      </div>
      {data && !error && visibleSkills?.length === 0 && (
        <section className="card skill-catalog-empty">
          <h2>{data.items.length ? "No skills match" : "No skills yet"}</h2>
          <p className="muted">
            {data.items.length
              ? "Try another search or change the skill state."
              : "Create or import a skill to get started."}
          </p>
          {(search || filter !== "all") && (
            <button type="button" className="secondary" onClick={resetFilters}>
              Reset filters
            </button>
          )}
        </section>
      )}
      {visibleSkills?.map((s) => (
        <section className="card skill-card" key={s.id}>
          <SkillCardHeader
            key={`${s.id}:${s.version}`}
            skill={s}
            onEdit={() => setEditing(s)}
            onAction={async (action) => {
              await api(
                `/api/admin/workspaces/${id}/skills/${s.id}/action`,
                "POST",
                {
                  version: s.version,
                  action,
                },
              );
              reload();
            }}
          />
          <p className="skill-card-description">{s.draft.description}</p>
          {s.origin && (
            <p className="muted">
              Saved from a conversation by {s.origin.actor} on{" "}
              {new Date(s.origin.sharedAt).toLocaleDateString()}.{" "}
              {s.published.length
                ? "Approved reusable instruction skill."
                : "Review before publishing. Publication saves this procedure independently of conversation retention; enable it for team use."}
            </p>
          )}
          <div className="skill-card-meta">
            <span>Revision {s.version}</span>
            <span>
              {s.published.length} published{" "}
              {s.published.length === 1 ? "version" : "versions"}
            </span>
          </div>
          <details className="skill-card-preview">
            <summary>Preview instructions & dependent schedules</summary>
            <p className="prose">{s.draft.body}</p>
            <DataDetails
              value={{
                settings: s.draft.settings,
                tools: s.draft.tools,
                dependents: s.dependents,
              }}
            />
          </details>
          <div className="skill-card-footer">
            <div className="skill-card-actions">
              <Action
                onClick={async () => {
                  await api(
                    `/api/admin/workspaces/${id}/skills/${s.id}/action`,
                    "POST",
                    { version: s.version, action: "publish" },
                  );
                  reload();
                }}
              >
                Publish draft
              </Action>
              <span className="skill-card-secondary">
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
              </span>
            </div>
            {s.published.length > 0 && (
              <details className="skill-card-versions">
                <summary>Restore a published version</summary>
                <p className="muted">
                  Copies the selected version into the draft and publishes it as
                  a new version.
                </p>
                <div className="skill-card-rollback">
                  <Field label="Rollback source version">
                    <Select
                      value={rollbackVersions[s.id] ?? 1}
                      onChange={(e) =>
                        setRollbackVersions((versions) => ({
                          ...versions,
                          [s.id]: Number(e.target.value),
                        }))
                      }
                    >
                      {s.published.map((_, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: Published versions are immutable and append-only; their position is their version number.
                        <option key={index + 1} value={index + 1}>
                          Version {index + 1}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <span className="skill-card-secondary">
                    <Action
                      onClick={async () => {
                        await api(
                          `/api/admin/workspaces/${id}/skills/${s.id}/action`,
                          "POST",
                          {
                            version: s.version,
                            action: "rollback",
                            pin: rollbackVersions[s.id] ?? 1,
                          },
                        );
                        reload();
                      }}
                    >
                      Publish rollback as new version
                    </Action>
                  </span>
                </div>
              </details>
            )}
          </div>
        </section>
      ))}
      {(creating || editing) && (
        <Modal
          title={editing ? `Edit ${editing.draft.name}` : "Create skill"}
          onClose={closeEditor}
        >
          <RecordForm
            fields={prefixFields(editing ? "spec." : "", skillFields)}
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
        {result !== undefined && <DataDetails value={result} />}
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
          <ModalActions>
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
          </ModalActions>
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
      {error && <Notice error>{error}</Notice>}
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
          <RecordForm
            fields={instructionFields}
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
      <ApprovalList id={id} reloadParent={reload} refreshKey={data} />
    </Page>
  );
}
type AdminRun = Run & { deliveries: Delivery[] };

function RunCard({
  title,
  run,
  detail,
  to,
}: {
  title: string;
  run: RunSummary;
  detail: string;
  to: string;
}) {
  return (
    <Link className="run-card" to={to}>
      <span className="run-card-heading">
        <span className="run-card-title">{title}</span>
        <span className="pill">{run.status}</span>
      </span>
      <span className="run-card-line">
        {new Date(run.at).toLocaleString()} · Actor {run.actor} · {run.model}
      </span>
      <span className="run-card-line">{detail}</span>
    </Link>
  );
}

function RunMessages({ run }: { run: AdminRun }) {
  const checkpoints = run.transcript.map((value) => {
    const message =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .filter(
        (part): part is { type: "text"; text: string } =>
          part?.type === "text" && typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("\n");
    const calls = content
      .filter(
        (part): part is { type: "toolCall"; name: string } =>
          part?.type === "toolCall" && typeof part.name === "string",
      )
      .map((part) => part.name);
    const role = message.role;
    return {
      label:
        role === "assistant"
          ? "Assistant"
          : role === "toolResult"
            ? `Tool · ${typeof message.toolName === "string" ? message.toolName : "Result"}`
            : role === "user"
              ? "User"
              : "Checkpoint",
      text,
      calls,
    };
  });
  const lastAssistant = checkpoints.findLast(
    (entry) => entry.label === "Assistant" && entry.text,
  );
  return (
    <section className="run-message-section" aria-label="Messages">
      <h2>Messages</h2>
      <ol className="run-messages">
        <li>
          <strong>Request</strong>
          <p className="prose">{run.task}</p>
        </li>
        {checkpoints.map((entry, index) => (
          // Checkpoints are an ordered, immutable snapshot and need not have IDs.
          // biome-ignore lint/suspicious/noArrayIndexKey: Ordered run transcript.
          <li key={index}>
            <strong>{entry.label}</strong>
            {entry.text && <p className="prose">{entry.text}</p>}
            {entry.calls.length > 0 && (
              <p className="muted">Called {entry.calls.join(", ")}</p>
            )}
            {!entry.text && entry.calls.length === 0 && (
              <p className="muted">No text content</p>
            )}
          </li>
        ))}
        {run.result && run.result.trim() !== lastAssistant?.text.trim() && (
          <li>
            <strong>Final answer</strong>
            <p className="prose">{run.result}</p>
          </li>
        )}
      </ol>
    </section>
  );
}

function RunsPage({ id }: { id: string }) {
  const [params] = useSearchParams();
  const rawOffset = Number(params.get("offset"));
  const offset =
    Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  return <RunListPage key={`${id}:${offset}`} id={id} offset={offset} />;
}
function RunListPage({ id, offset }: { id: string; offset: number }) {
  const [params] = useSearchParams();
  const detailParams = new URLSearchParams(params);
  detailParams.set("workspace", id);
  const { data, error, reload, loading } = useData<RunHistoryPage>(
    `/api/admin/workspaces/${id}/runs?offset=${offset}&limit=25`,
  );
  const memberData = data?.mode === "member" ? data : undefined;
  return (
    <Page
      title="Runs & delivery"
      description="Generation and delivery have separate states. An unknown send is never automatically repeated."
      actions={
        <>
          {memberData && (
            <CreateModal label="Request a run">
              {(close) => (
                <>
                  <RecordForm
                    fields={runFields}
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
          )}
          {error && (
            <Action loading={loading} onClick={async () => reload()}>
              Try again
            </Action>
          )}
        </>
      }
    >
      {error && <Notice error>{error}</Notice>}
      {!data && loading && (
        <section aria-label="Runs" aria-busy="true">
          <SkeletonRows label="Run summaries" rows={3} />
        </section>
      )}
      {data?.total === 0 && (
        <section className="card">No assistant runs yet.</section>
      )}
      {data && data.total > 0 && data.items.length === 0 && (
        <section className="card">
          No runs on this page. Use Previous page to return to earlier results.
        </section>
      )}
      {data?.items.map((r) => (
        <RunCard
          key={r.id}
          title={memberData ? r.taskPreview : `Run ${r.id.slice(0, 8)}`}
          run={r}
          detail={`${r.attemptCount} model ${r.attemptCount === 1 ? "attempt" : "attempts"} · Delivery: ${r.deliveryStates.join(", ") || "none"}`}
          to={`/admin/runs/${r.id}?${detailParams.toString()}`}
        />
      ))}
      <Pager data={data} pageSize={25} loading={loading} alwaysShow />
    </Page>
  );
}
function RunDetailRoute({ id }: { id: string }) {
  const { runId = "" } = useParams();
  return <RunDetailPage key={`${id}:${runId}`} id={id} runId={runId} />;
}
function RunDetailPage({ id, runId }: { id: string; runId: string }) {
  const [params] = useSearchParams();
  const backParams = new URLSearchParams(params);
  backParams.set("workspace", id);
  const { data, error, reload, loading } = useData<{
    mode: "member" | "operator";
    run: AdminRun;
  }>(`/api/admin/workspaces/${id}/runs/${encodeURIComponent(runId)}`);
  const run = data?.run;
  return (
    <>
      <p>
        <Link
          className="page-back-link"
          to={`/admin/runs?${backParams.toString()}`}
        >
          <ChevronLeft
            size={18}
            weight="Outline"
            color="currentColor"
            aria-hidden="true"
          />
          Back to Runs
        </Link>
      </p>
      <Page
        title={`Run ${runId.slice(0, 8)}`}
        titleBadge={run?.status}
        actions={
          error && (
            <Action loading={loading} onClick={async () => reload()}>
              Try again
            </Action>
          )
        }
      >
        {error && (
          <Notice error>
            {error === "not_found"
              ? "This run is unavailable in this workspace. It may have expired or been removed."
              : error}
          </Notice>
        )}
        {!run && loading && (
          <section className="card" aria-label="Run details" aria-busy="true">
            <Skeleton width="65%" />
            <h2>Messages</h2>
            <SkeletonRows label="Run messages" rows={3} />
          </section>
        )}
        {run && data && (
          <section
            className="card"
            aria-label="Run details"
            aria-busy={loading}
          >
            <p className="mono run-id">{run.id}</p>
            <p className="muted">
              {new Date(run.at).toLocaleString()} · Actor {run.actor} ·{" "}
              {run.model} · Settings v{run.settingsVersion}
              {run.workflowVersion && ` · Workflow v${run.workflowVersion}`}
            </p>
            {run.error && <Notice error>{run.error}</Notice>}
            <RunMessages run={run} />
            {run.coverage && <p className="muted">{run.coverage}</p>}
            <details>
              <summary>Versions, usage, checkpoints & delivery</summary>
              <DataDetails
                value={{
                  skillPins: run.skillPins,
                  instructions: run.instructions.map((i) => ({
                    id: i.id,
                    version: i.version,
                  })),
                }}
              />
              <RunAttempts attempts={run.attempts} />
              <DataDetails
                value={{
                  transcript: run.transcript,
                  deliveries: run.deliveries,
                }}
              />
            </details>
            {data.mode === "member" && (
              <>
                <RunRecovery id={id} run={run} reload={reload} />
                <div className="row">
                  <Action
                    icon="stop"
                    onClick={async () => {
                      await api(
                        `/api/admin/workspaces/${id}/runs/${run.id}/cancel`,
                        "POST",
                        {},
                      );
                      reload();
                    }}
                  >
                    Cancel
                  </Action>
                  {["failed", "partial", "cancelled"].includes(run.status) && (
                    <Action
                      onClick={async () => {
                        await api(
                          `/api/admin/workspaces/${id}/runs/${run.id}/retry`,
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
              </>
            )}
          </section>
        )}
      </Page>
    </>
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
            <RecordForm
              fields={chargeFields}
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
            <RecordForm
              fields={deliveryFields}
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
  const { data, error, reload } = useData<
    | { status: "not_requested"; retentionDays: number }
    | { requestedAt: string; purgedAt?: string; providerState: string }
  >(`/api/admin/workspaces/${id}/deletion`);
  const [confirm, setConfirm] = useState("");
  return (
    <Page
      title="Privacy & removal"
      description="Deletion revokes access immediately, cancels pending work, and purges stored content on the worker sweep."
    >
      {error && <Notice error>{error}</Notice>}
      <section className="card">
        {data ? (
          <>
            <p>
              <strong>Workspace removal: </strong>
              {"status" in data
                ? "No deletion requested."
                : data.purgedAt
                  ? "Stored content removed."
                  : "Deletion in progress."}
            </p>
            {"retentionDays" in data ? (
              <p>
                <strong>Message retention: </strong>
                {data.retentionDays} {data.retentionDays === 1 ? "day" : "days"}
                .
              </p>
            ) : (
              <p>
                <strong>{data.purgedAt ? "Removed: " : "Requested: "}</strong>
                {new Date(data.purgedAt ?? data.requestedAt).toLocaleString()}
              </p>
            )}
          </>
        ) : !error ? (
          <dl className="plugin-summary" aria-busy="true">
            <div>
              <dt>Workspace removal</dt>
              <dd>
                <Skeleton width="12rem" />
              </dd>
            </div>
            <div>
              <dt>Message retention</dt>
              <dd>
                <Skeleton width="6rem" />
              </dd>
            </div>
          </dl>
        ) : null}
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
      <ApprovalList id={id} reloadParent={reload} refreshKey={data} />
    </Page>
  );
}
function Operations() {
  const { data, error, reload, loading } = useData<{
    workers: number;
    failed_runs: number;
    unknown_deliveries: number;
    pending: number;
    oldest_seconds: number;
    paused: boolean;
    audit: Record<string, unknown>[];
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
      {error && <Notice error>{error}</Notice>}
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
        {(error || progress.error) && (
          <Action
            loading={loading || progress.loading}
            onClick={async () => {
              reload();
              progress.reload();
            }}
          >
            Try again
          </Action>
        )}
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
        {diagnostic !== undefined && <DataDetails value={diagnostic} />}
        <h2>Recent operator actions</h2>
        <DataTable
          rows={data?.audit}
          label="Operator actions"
          columns={[
            { key: "at", label: "Time" },
            { key: "action", label: "Action" },
            { key: "actor", label: "Actor" },
            { key: "target", label: "Target" },
          ]}
        />
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
                <RecordForm
                  fields={accountFields}
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
        {accountResult !== undefined && <DataDetails value={accountResult} />}
        <h3>Issue identity verification</h3>
        <p>
          Enroll the intended Telegram ID in Members first. Verification
          succeeds only for an eligible workspace member.
        </p>
        <RecordForm
          fields={[
            { path: "accountId", label: "Panel account ID", required: true },
            workspaceOptions(progress.data?.workspaces ?? []),
          ]}
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
        <RecordForm
          fields={[
            workspaceOptions(progress.data?.workspaces ?? []),
            { path: "telegramId", label: "Telegram user ID", required: true },
          ]}
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
        <DataTable
          label="Workspaces"
          rows={progress.data?.workspaces.map((workspace) => ({
            name: workspace.settings.name,
            status: workspace.deleted ? "Removed" : "Active",
            ownerVerified: workspace.ownerVerified,
            skills: `${workspace.skills.filter((skill) => skill.enabled).length} of ${workspace.skills.length} enabled`,
            timezone: workspace.settings.timezone,
          }))}
          columns={[
            { key: "name", label: "Workspace" },
            { key: "status", label: "Status" },
            { key: "ownerVerified", label: "Telegram owner linked" },
            { key: "skills", label: "Skills" },
            { key: "timezone", label: "Timezone" },
          ]}
        />
      </section>
    </Page>
  );
}
function WorkspacePicker({
  workspaces,
  chosen,
  operator,
  onSelect,
  onCreate,
}: {
  workspaces: { id: string; name: string }[];
  chosen: string;
  operator: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const focusOnOpen = useRef<"first" | "last" | null>(null);
  const selected = workspaces.find((workspace) => workspace.id === chosen);
  const currentLabel =
    selected?.name ??
    (operator ? "No workspaces yet" : "Verify Telegram to continue");
  const items = useCallback(
    () =>
      Array.from(
        root.current?.querySelectorAll<HTMLButtonElement>(
          ".workspace-menu-item",
        ) ?? [],
      ),
    [],
  );
  useEffect(() => {
    if (!open) return;
    if (focusOnOpen.current) {
      const options = items();
      (focusOnOpen.current === "first" ? options[0] : options.at(-1))?.focus();
      focusOnOpen.current = null;
    }
    const closeOutside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
    };
  }, [open, items]);
  const handleMenuKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        focusOnOpen.current = event.key === "ArrowDown" ? "first" : "last";
        setOpen(true);
        return;
      }
      const options = items();
      const index = options.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const next =
        index < 0
          ? event.key === "ArrowDown"
            ? 0
            : options.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
            options.length;
      options[next]?.focus();
    } else if (open && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      const options = items();
      (event.key === "Home" ? options[0] : options.at(-1))?.focus();
    }
  };
  return (
    <div className="workspace-picker">
      <span className="workspace-picker-label">Workspace</span>
      <div className="workspace-picker-control" ref={root}>
        <button
          ref={trigger}
          type="button"
          className="workspace-picker-trigger dropdown-trigger"
          aria-label="Workspace"
          aria-describedby="workspace-picker-current"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? "workspace-picker-menu" : undefined}
          disabled={!workspaces.length && !operator}
          onClick={() => {
            if (open) setOpen(false);
            else {
              focusOnOpen.current = "first";
              setOpen(true);
            }
          }}
          onKeyDown={handleMenuKeyDown}
        >
          <span id="workspace-picker-current">{currentLabel}</span>
        </button>
        {open && (
          <div
            id="workspace-picker-menu"
            className="workspace-picker-menu dropdown-menu"
            role="menu"
            aria-label="Workspaces"
            onKeyDown={handleMenuKeyDown}
          >
            {workspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                className="workspace-menu-item dropdown-item"
                role="menuitemradio"
                aria-checked={workspace.id === chosen}
                data-workspace-id={workspace.id}
                onClick={() => {
                  setOpen(false);
                  onSelect(workspace.id);
                  trigger.current?.focus();
                }}
              >
                <span>{workspace.name}</span>
                {workspace.id === chosen && (
                  <span className="workspace-menu-check" aria-hidden="true">
                    <Check size={20} weight="Outline" color="currentColor" />
                  </span>
                )}
              </button>
            ))}
            {operator && (
              <button
                type="button"
                className="workspace-menu-item dropdown-item workspace-menu-create"
                role="menuitem"
                aria-label="New workspace"
                onClick={() => {
                  trigger.current?.focus();
                  setOpen(false);
                  onCreate();
                }}
              >
                New
              </button>
            )}
          </div>
        )}
      </div>
    </div>
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
  const location = useLocation();
  const navigate = useNavigate();
  const [locationParams] = useSearchParams();
  const requestedWorkspace = locationParams.get("workspace");
  useEffect(() => {
    if (!current) return;
    const expire = () => {
      setCurrent(undefined);
      setWorkspace("");
      setWorkspaces([]);
      navigate("/admin", { replace: true });
    };
    sessionEvents.addEventListener("expired", expire);
    return () => sessionEvents.removeEventListener("expired", expire);
  }, [current, navigate]);
  useEffect(() => {
    if (
      requestedWorkspace &&
      workspaces.some((w) => w.id === requestedWorkspace)
    )
      setWorkspace(requestedWorkspace);
  }, [requestedWorkspace, workspaces]);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const status = await api<{ initialized: boolean }>("/api/setup/status");
      setInitialized(status.initialized);
      try {
        const s = await api<Session>("/api/admin/auth/session");
        const available = await api<{ id: string; name: string }[]>(
          "/api/admin/workspaces",
        );
        csrf = s.csrf;
        setWorkspaces(available);
        setCurrent(s);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 401) throw e;
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
  useEffect(() => {
    void location.key;
    if (!current) return;
    void api<{ id: string; name: string }[]>("/api/admin/workspaces")
      .then(setWorkspaces)
      .catch(() => {});
  }, [current, location.key]);
  const chosen = workspace || workspaces[0]?.id || "";
  const selectWorkspace = (id: string) => {
    setWorkspace(id);
    const params = new URLSearchParams(location.search);
    params.set("workspace", id);
    navigate(
      { pathname: location.pathname, search: params.toString() },
      { replace: true },
    );
  };
  const setupLayout = !!current && location.pathname === "/setup";
  const navigation: [string, string][] = [
    ["overview", "Overview"],
    ["members", "Members & access"],
    ["chats", "Group access"],
    ["workflows", "Workflows"],
    ["skills", "Skills"],
    ["instructions", "Instructions"],
    ["runs", "Runs"],
    ["usage", "Usage"],
    ["audit", "Audit"],
    ["deletion", "Privacy"],
    ["settings", "Settings"],
  ];
  const operatorOnly = !!current?.admin.operator && !current.admin.telegramId;
  const visibleNavigation = operatorOnly
    ? navigation.filter(([path]) =>
        [
          "overview",
          "members",
          "workflows",
          "skills",
          "runs",
          "settings",
        ].includes(path),
      )
    : navigation;
  if (loading || error)
    return (
      <main className="app-loading">
        <div
          className="brand"
          role="status"
          aria-label={loading ? "Opening RepoDesk" : "RepoDesk"}
          aria-busy={loading}
        >
          <img
            className="brand-mark"
            src="/assets/repodesk-mark.svg"
            width="42"
            height="42"
            alt=""
          />
          <div>
            RepoDesk<span>GITHUB ASSISTANT</span>
          </div>
        </div>
        {error && (
          <section className="card">
            <Notice error>{error}</Notice>
            <button type="button" onClick={() => void load()}>
              Try again
            </button>
          </section>
        )}
      </main>
    );
  return (
    <div
      className={
        current && !setupLayout
          ? "layout"
          : `layout layout-auth${setupLayout ? " layout-setup" : ""}`
      }
    >
      <ApplicationUpdate session={current} request={api} />
      <Sidebar enabled={!!current && !setupLayout}>
        <div className="brand">
          <img
            className="brand-mark"
            src="/assets/repodesk-mark.svg"
            width="42"
            height="42"
            alt=""
          />
          <div>
            RepoDesk<span>GITHUB ASSISTANT</span>
          </div>
        </div>
        {current && !setupLayout ? (
          <>
            <WorkspacePicker
              workspaces={workspaces}
              chosen={chosen}
              operator={current.admin.operator}
              onSelect={selectWorkspace}
              onCreate={() => navigate("/setup?new=1&step=workspace")}
            />
            <nav>
              {chosen &&
                visibleNavigation
                  .filter(([path]) => path !== "settings")
                  .map(([path, label]) => (
                    <NavLink key={path} to={`/admin/${path}`}>
                      {label}
                    </NavLink>
                  ))}
              {chosen && current.admin.operator && (
                <NavLink to="/admin/plugins">Plugins</NavLink>
              )}
              {chosen && <NavLink to="/admin/settings">Settings</NavLink>}
              {current.admin.operator && (
                <>
                  <p className="nav-label">DEPLOYMENT</p>
                  <NavLink to="/admin/model">Model settings</NavLink>
                  <NavLink to="/admin/site">Site domain</NavLink>
                  <NavLink to="/setup">Setup</NavLink>
                  <NavLink to="/admin/operations">Operations</NavLink>
                  <NavLink to="/admin/logs">Runtime logs</NavLink>
                </>
              )}
            </nav>
            <div className="account">
              <div className="account-identity">
                <small>
                  {current.admin.username}
                  {current.admin.telegramId && ` · ${current.admin.telegramId}`}
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
              </div>
              <ThemeSwitch />
            </div>
          </>
        ) : (
          <>
            <div className="auth-hero">
              <p className="auth-hero-kicker">A WORKSPACE FOR YOUR TEAM</p>
              <h2>Make room for better work.</h2>
              <p className="auth-hero-copy">
                Set up your assistant, connect Telegram, and choose how your
                team works with it.
              </p>
              <AuthNetwork />
            </div>
            <p className="auth-hero-footer">RepoDesk / Your deployment</p>
            {current && (
              <div className="account setup-account">
                <div className="account-identity">
                  <small>
                    {current.admin.username}
                    {current.admin.telegramId && " · Telegram linked"}
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
                </div>
                <ThemeSwitch />
              </div>
            )}
          </>
        )}
      </Sidebar>
      <main
        className={
          setupLayout ? "setup-main" : !current ? "auth-main" : undefined
        }
      >
        {!current ? (
          <Auth
            claim={!initialized}
            onDone={async () => {
              const session = await api<Session>("/api/admin/auth/session");
              const available = await api<{ id: string; name: string }[]>(
                "/api/admin/workspaces",
              );
              csrf = session.csrf;
              setInitialized(true);
              setWorkspaces(available);
              setCurrent(session);
              navigate(initialized ? "/admin" : "/setup", { replace: true });
            }}
          />
        ) : (
          <Routes>
            <Route path="/setup" element={<Setup />} />
            <Route
              path="/admin/model"
              element={
                current.admin.operator ? (
                  <ModelSettings workspaceId={chosen} />
                ) : (
                  <Page title="Operator access required">
                    <p>Model settings are available to deployment operators.</p>
                  </Page>
                )
              }
            />
            <Route path="/admin/operations" element={<Operations />} />
            <Route
              path="/admin/site"
              element={
                current.admin.operator ? (
                  <Page
                    title="Site domain"
                    description="Set the public address for this admin panel and its connected services."
                  >
                    <SiteDomain request={api} />
                  </Page>
                ) : (
                  <Page title="Operator access required">
                    <p>Site domains can be managed by deployment operators.</p>
                  </Page>
                )
              }
            />
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
              path="/admin/plugins/file/:pluginId"
              element={
                current.admin.operator ? (
                  chosen ? (
                    <Plugins
                      key={chosen}
                      request={api}
                      workspaceId={chosen}
                      view="installed"
                    />
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
              path="/admin/plugins/market/:pluginId"
              element={
                current.admin.operator ? (
                  chosen ? (
                    <Plugins
                      key={chosen}
                      request={api}
                      workspaceId={chosen}
                      view="market"
                    />
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
              path="/admin/plugins/:pluginId"
              element={
                current.admin.operator ? (
                  chosen ? (
                    <Plugins
                      key={chosen}
                      request={api}
                      workspaceId={chosen}
                      view="installed"
                    />
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
            <Route
              path="/admin/access-policy"
              element={
                <Navigate
                  to={`/admin/members?${locationParams.toString()}`}
                  replace
                />
              }
            />
            <Route
              path="/admin/workflows/:workflowId"
              element={chosen ? <WorkflowDetailRoute id={chosen} /> : <Setup />}
            />
            <Route
              path="/admin/runs/:runId"
              element={chosen ? <RunDetailRoute id={chosen} /> : <Setup />}
            />
            {visibleNavigation.map(([path]) => (
              <Route
                key={path}
                path={`/admin/${path}`}
                element={
                  chosen ? (
                    <WorkspacePage
                      key={`${chosen}:${path}`}
                      id={chosen}
                      resource={path ?? "overview"}
                      admin={current.admin}
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
                  <WorkspacePage
                    id={chosen}
                    resource="overview"
                    admin={current.admin}
                  />
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
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </BrowserRouter>,
  );
