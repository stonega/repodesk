import { type FormEvent, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Refresh } from "reicon-react";
import {
  api,
  Field,
  Notice,
  Page,
  type Progress,
  setCsrf,
  useData,
} from "../admin-shared.tsx";
import { GitHubSetup } from "../github.tsx";
import { ModelProvidersPanel } from "../model-providers.tsx";
import { Select } from "../select.tsx";
import { SkeletonRows } from "../skeleton.tsx";

export function Auth({
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
      setCsrf(result.csrf);
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
export function Setup() {
  const { data, error, reload } = useData<Progress>("/api/setup/progress");
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const creatingWorkspace = params.get("new") === "1";
  const selected = params.get("workspace");
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
              onConnected={() =>
                navigate(`/admin?workspace=${workspace.id}`, { replace: true })
              }
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
            disabled={workspaceSaving || credentialSaving}
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
    </Page>
  );
}
export function ModelSettings({ workspaceId }: { workspaceId: string }) {
  const { data } = useData<Progress>("/api/setup/progress");
  return (
    <Page
      title="Model settings"
      description="Choose your model provider and chat model. The bot activates automatically when setup is ready."
    >
      <ModelProvidersPanel
        key={workspaceId}
        request={api}
        workspaceId={workspaceId}
        legacyModel={data?.model}
      />
    </Page>
  );
}
export function TelegramCredentialForm({
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
