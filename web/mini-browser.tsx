import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { PersonalBrowserPage } from "../src/browser/member.ts";
import type { HostResult } from "../src/browser/protocol.ts";
import { Modal, ModalActions } from "./modal.tsx";

const messages: Record<string, string> = {
  access_denied: "You no longer have access to this workspace.",
  miniapp_auth_invalid:
    "Reopen Browser from your bot’s private conversation to verify your identity.",
  miniapp_auth_required: "Open Browser from your bot’s private conversation.",
  miniapp_auth_expired:
    "Your Telegram session expired. Reopen Browser from the bot.",
  miniapp_unavailable:
    "The bot is unavailable or paused. Try again after it reconnects.",
  browser_disabled: "Browser is disabled for this workspace.",
  browser_service_unavailable:
    "The host browser service is unavailable. Ask the deployment operator to check its connection.",
  browser_request_expired:
    "This request expired. Ask the task to request access again.",
  browser_request_unavailable:
    "This request changed or was already handled. Refresh to see its current status.",
  browser_input_unavailable:
    "This input request is no longer available. Refresh to see the current request.",
  browser_control_expired:
    "Browser control changed. Refresh before continuing.",
  browser_state_changed:
    "Your browser changed in another session. Refresh before taking control.",
  browser_authorization_expired:
    "Browser authorization changed. Reopen the task from Telegram.",
  browser_cleanup_pending:
    "Your browser is closing. Wait for cleanup before reopening it.",
  browser_input_pending: "Complete or cancel the current input request first.",
  browser_page_changed:
    "The destination or field changed. Ask the task for a new input request.",
  browser_outcome_unknown:
    "The result could not be confirmed. Check the page before trying another action.",
  browser_destination_denied:
    "This destination is not allowed. Local previews need operator configuration.",
  browser_page_unavailable:
    "No page is open. Take control and open a permitted website.",
  browser_capacity:
    "The browser reached its resource limit. Close unused tabs or try again later.",
  browser_field_unavailable:
    "Focus an editable field in the browser view, then request private input again.",
};
const fatalCodes = [
  "access_denied",
  "miniapp_auth_required",
  "miniapp_auth_invalid",
  "miniapp_auth_expired",
  "browser_authorization_expired",
];

function InputRequest({
  input,
  busy,
  submit,
  cancel,
}: {
  input: NonNullable<PersonalBrowserPage["input"]>;
  busy: boolean;
  submit: (value: string, submissionId: string) => Promise<void>;
  cancel: () => void;
}) {
  const submission = useRef(crypto.randomUUID());
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      value = String(new FormData(form).get("secret") ?? "");
    // Clear the DOM before awaiting network work. Never place the value in React state or storage.
    form.reset();
    if (value) await submit(value, submission.current);
  }
  return (
    <section className="mini-browser-card" aria-label="Private input request">
      <h2>{input.label}</h2>
      <p>{input.task}</p>
      <p className="mini-muted">{input.consumer} · Verified destination</p>
      <code className="mini-browser-origin">{input.origin}</code>
      {input.state === "waiting" ? (
        <form onSubmit={(event) => void send(event)} autoComplete="off">
          <label htmlFor="browser-secret">
            {input.kind === "code"
              ? "Verification code"
              : input.kind === "password"
                ? "Password"
                : "Private value"}
          </label>
          <input
            id="browser-secret"
            name="secret"
            type="password"
            autoComplete="off"
            inputMode={input.kind === "code" ? "numeric" : undefined}
            maxLength={4096}
            required
            disabled={busy}
            aria-describedby="browser-input-help"
          />
          <p id="browser-input-help" className="mini-muted">
            Applied only to this task’s current field. It is not sent to the
            model or saved in chat.
          </p>
          <div className="mini-browser-actions">
            <button className="mini-primary" type="submit" disabled={busy}>
              {busy ? "Submitting…" : "Apply securely"}
            </button>
            <button type="button" disabled={busy} onClick={cancel}>
              Cancel request
            </button>
          </div>
        </form>
      ) : (
        <p role="status">
          {input.state === "completed"
            ? input.consumer === "human"
              ? "Input applied to your browser."
              : "Input applied. Your task will continue."
            : input.state === "applying"
              ? "Applying input… Do not resubmit."
              : `Request ${input.state}. No value is shown here.`}
        </p>
      )}
    </section>
  );
}

export function BrowserMini() {
  const app = window.Telegram?.WebApp;
  const reference =
    app?.initDataUnsafe?.start_param ||
    new URLSearchParams(location.search).get("tgWebAppStartParam") ||
    "";
  const [data, setData] = useState<PersonalBrowserPage>();
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [image, setImage] = useState("");
  const [pageBinding, setPageBinding] = useState<HostResult["page"]>();
  const lastView = useRef("");
  const [tabs, setTabs] = useState<NonNullable<HostResult["tabs"]>>([]);
  const [downloads, setDownloads] = useState<
    NonNullable<HostResult["downloads"]>
  >([]);
  const [confirm, setConfirm] = useState<"takeover" | "delete" | "close">();
  const mounted = useRef(true),
    lock = useRef(false),
    refreshing = useRef(false),
    abort = useRef(new AbortController());
  const request = useCallback(
    async <T,>(path: string, operation?: unknown): Promise<T> => {
      const response = await fetch(`/mini-api/browser/${path}`, {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initData: app?.initData ?? "",
          reference,
          ...(operation === undefined ? {} : { operation }),
        }),
        signal: abort.current.signal,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (fatalCodes.includes(result.error) && mounted.current) {
          setBlocked(true);
          setConfirm(undefined);
          setData(undefined);
          setImage("");
          setTabs([]);
          setDownloads([]);
        }
        throw Error(
          messages[result.error] ??
            "Could not complete the request. Refresh and check its status before trying again.",
        );
      }
      return result as T;
    },
    [app?.initData, reference],
  );
  const refresh = useCallback(async () => {
    if (
      refreshing.current ||
      lock.current ||
      document.hidden ||
      app?.isActive === false
    )
      return;
    refreshing.current = true;
    try {
      const page = await request<PersonalBrowserPage>("view");
      if (mounted.current) {
        const signature = `${page.generation}:${page.enabled}:${page.configured}:${page.lifecycle ?? ""}`;
        if (lastView.current && signature !== lastView.current) {
          setImage("");
          setPageBinding(undefined);
          setTabs([]);
          setDownloads([]);
        }
        lastView.current = signature;
        setData(page);
        setLoadError("");
        if (!page.enabled || page.lifecycle || !page.configured) {
          setImage("");
          setTabs([]);
          setDownloads([]);
        }
      }
    } catch (cause) {
      if (mounted.current && !abort.current.signal.aborted)
        setLoadError((cause as Error).message);
    } finally {
      refreshing.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [request, app?.isActive]);
  useEffect(() => {
    mounted.current = true;
    abort.current = new AbortController();
    document.title = "RepoDesk · My browser";
    const theme = () => {
      document.documentElement.dataset.theme = app?.colorScheme ?? "light";
      for (const [key, value] of Object.entries(app?.themeParams ?? {}))
        if (/^#[a-f\d]{6}$/i.test(value))
          document.documentElement.style.setProperty(
            `--tg-theme-${key.replaceAll("_", "-")}`,
            value,
          );
      if (app?.viewportStableHeight)
        document.documentElement.style.setProperty(
          "--mini-height",
          `${app.viewportStableHeight}px`,
        );
      for (const edge of ["top", "right", "bottom", "left"])
        document.documentElement.style.setProperty(
          `--mini-safe-${edge}`,
          `${(app?.safeAreaInset?.[edge] ?? 0) + (app?.contentSafeAreaInset?.[edge] ?? 0)}px`,
        );
    };
    theme();
    app?.ready();
    app?.expand();
    app?.BackButton?.hide();
    app?.MainButton?.hide();
    const events = [
      "themeChanged",
      "viewportChanged",
      "safeAreaChanged",
      "contentSafeAreaChanged",
    ];
    for (const event of events) app?.onEvent(event, theme);
    return () => {
      mounted.current = false;
      abort.current.abort();
      for (const event of events) app?.offEvent(event, theme);
    };
  }, [app]);
  useEffect(() => {
    if (blocked) return;
    if (!app?.initData) {
      setLoading(false);
      setError(messages.miniapp_auth_required ?? "Open Browser from Telegram.");
      return;
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 4000),
      wake = () => void refresh();
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    app.onEvent("activated", wake);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      app.offEvent("activated", wake);
    };
  }, [refresh, blocked, app]);
  async function act(path: string, operation: unknown, success?: string) {
    if (lock.current || blocked) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await request<HostResult>(path, operation);
      if (!mounted.current) return;
      if (result.tabs) setTabs(result.tabs);
      if (result.downloads) setDownloads(result.downloads);
      if (success) setNotice(success);
      setConfirm(undefined);
      if (result.status === "closed") {
        setImage("");
        setTabs([]);
      }
      return result;
    } catch (cause) {
      if (mounted.current && !abort.current.signal.aborted)
        setError((cause as Error).message);
    } finally {
      lock.current = false;
      if (mounted.current) {
        setBusy(false);
        void refresh();
      }
    }
  }
  async function capture() {
    const result = await act("operate", {
      command: "observe",
      view: "screenshot",
    });
    if (!result?.reference) return;
    const file = await act("operate", {
      command: "artifact",
      id: result.reference,
    });
    if (mounted.current && file?.artifact?.mimeType === "image/jpeg") {
      setImage(`data:image/jpeg;base64,${file.artifact.data}`);
      setPageBinding(result.page);
    }
  }
  async function download(id: string) {
    const result = await act("operate", { command: "artifact", id });
    if (!result?.artifact || !mounted.current) return;
    const file = result.artifact,
      blob = new Blob(
        [Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0))],
        { type: file.mimeType },
      ),
      url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const ownControl = data?.controller?.kind === "human";
  const action = (input: Record<string, unknown>) => {
    if (
      ["navigate", "select_tab", "close_tab", "new_tab"].includes(
        String(input.action),
      )
    ) {
      setImage("");
      setPageBinding(undefined);
    }
    return act("operate", {
      command: "action",
      generation: data?.generation,
      operationId: crypto.randomUUID(),
      input,
      ...(["pointer", "press", "scroll", "click"].includes(String(input.action))
        ? { page: pageBinding }
        : {}),
    }).then(async (result) => {
      if (result?.status === "completed") await capture();
    });
  };
  const ready = !!data?.enabled && data.configured && !blocked;
  return (
    <main className="mini-shell mini-browser-shell">
      <header className="mini-heading">
        <span className="mini-eyebrow">REPODESK · PERSONAL</span>
        <h1>My browser</h1>
        <p className="mini-repository">
          {data?.workspace ?? "Your private workspace browser"}
        </p>
        <p className="mini-muted">
          Only you can view this profile. Chat and authorized plugins use your
          session after your approval.
        </p>
      </header>
      <div className="mini-browser-body" aria-busy={loading}>
        {(error || loadError) && (
          <div className="mini-browser-toast" role="alert">
            <span>{error || loadError}</span>
            {!blocked && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setError("");
                  void refresh();
                }}
              >
                Refresh status
              </button>
            )}
          </div>
        )}
        {notice && (
          <div className="mini-browser-toast" role="status">
            {notice}
            <button
              type="button"
              onClick={() => setNotice("")}
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        )}
        <section className="mini-browser-card" aria-label="Browser status">
          <h2>Session</h2>
          {loading ? (
            <p className="mini-placeholder">Checking your browser…</p>
          ) : !data ? (
            <p className="mini-muted">
              Verify your identity in Telegram to continue.
            </p>
          ) : (
            <>
              <dl className="mini-browser-summary">
                <div>
                  <dt>Plugin</dt>
                  <dd>{data.enabled ? "Enabled" : "Disabled"}</dd>
                </div>
                <div>
                  <dt>Host service</dt>
                  <dd>
                    {data.configured
                      ? "Configured · checked when used"
                      : "Not configured"}
                  </dd>
                </div>
                <div>
                  <dt>Control</dt>
                  <dd>
                    {data.controller
                      ? ownControl
                        ? "You"
                        : data.controller.kind
                      : "Available"}
                  </dd>
                </div>
              </dl>
              {!data.configured && (
                <p className="mini-muted">
                  Ask the deployment operator to connect the host browser
                  service.
                </p>
              )}
              {ready && (
                <div className="mini-browser-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      ownControl
                        ? void act(
                            "operate",
                            { command: "release", generation: data.generation },
                            "Control returned. Approved tasks can continue.",
                          )
                        : setConfirm("takeover")
                    }
                  >
                    {ownControl ? "Return control" : "Take control"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirm("close")}
                  >
                    Close browser
                  </button>
                </div>
              )}
            </>
          )}
        </section>
        {data?.input && ready && (
          <InputRequest
            key={data.input.id}
            input={data.input}
            busy={busy}
            submit={async (value, submissionId) => {
              await act(
                "input",
                { id: data.input?.id, submissionId, value },
                data.input?.consumer === "human"
                  ? "Input applied to your browser."
                  : "Input applied. Your task will continue.",
              );
            }}
            cancel={() =>
              void act(
                "operate",
                { command: "cancel_input", id: data.input?.id },
                "Input request cancelled.",
              )
            }
          />
        )}
        <section className="mini-browser-card" aria-label="Browser requests">
          <h2>Task requests</h2>
          {loading ? (
            <p className="mini-muted">Checking requests…</p>
          ) : !data?.requests.length ? (
            <p className="mini-muted">
              No requests. Ask the bot to use a website in your private
              conversation.
            </p>
          ) : (
            data.requests
              .slice()
              .reverse()
              .map((request) => (
                <article className="mini-browser-request" key={request.id}>
                  <strong>{request.task}</strong>
                  <p className="mini-muted">
                    {request.consumer} · {request.kind}
                  </p>
                  {request.origin && (
                    <code className="mini-browser-origin">
                      {request.origin}
                    </code>
                  )}
                  <p>{request.description}</p>
                  {request.state === "waiting" && ready ? (
                    <div className="mini-browser-actions">
                      <button
                        type="button"
                        className="mini-primary"
                        disabled={busy}
                        onClick={() =>
                          void act(
                            "decide",
                            { id: request.id, approve: true },
                            "Approved. The originating task will continue.",
                          )
                        }
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void act(
                            "decide",
                            { id: request.id, approve: false },
                            "Request denied.",
                          )
                        }
                      >
                        Deny
                      </button>
                    </div>
                  ) : (
                    <p className="mini-muted" role="status">
                      {request.state === "approved"
                        ? "Approved · waiting for the task"
                        : request.state === "applying"
                          ? "Applying…"
                          : request.state}
                    </p>
                  )}
                </article>
              ))
          )}
        </section>
        <section className="mini-browser-card" aria-label="Browser view">
          <h2>Browser view</h2>
          <p className="mini-muted">
            Screenshots mask input fields. Viewing does not take control from a
            task.
          </p>
          <div className="mini-browser-actions">
            <button
              type="button"
              disabled={!ready || busy}
              onClick={() => void capture()}
            >
              View browser
            </button>
            <button
              type="button"
              disabled={!ready || busy}
              onClick={() =>
                void act("operate", { command: "observe", view: "tabs" })
              }
            >
              Show tabs
            </button>
            <button
              type="button"
              disabled={!ready || busy}
              onClick={() => void act("operate", { command: "status" })}
            >
              Show downloads
            </button>
          </div>
          {image ? (
            <button
              type="button"
              className="mini-browser-screen"
              disabled={!ownControl || busy || !pageBinding}
              aria-label="Click a position in your browser"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                void action({
                  action: "pointer",
                  x: Math.max(
                    0,
                    Math.min(
                      1280,
                      Math.round(
                        ((event.clientX - rect.left) / rect.width) * 1280,
                      ),
                    ),
                  ),
                  y: Math.max(
                    0,
                    Math.min(
                      800,
                      Math.round(
                        ((event.clientY - rect.top) / rect.height) * 800,
                      ),
                    ),
                  ),
                });
              }}
            >
              <img
                src={image}
                alt="Private browser screenshot with input fields masked"
              />
            </button>
          ) : (
            <p className="mini-placeholder">
              Your browser view appears here when requested.
            </p>
          )}
          {!!tabs.length && (
            <ul className="mini-browser-tabs">
              {tabs.map((tab) => (
                <li key={tab.id}>
                  <span>
                    {tab.title || "Untitled tab"}
                    <small>{tab.url}</small>
                  </span>
                  {ownControl && (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void action({ action: "select_tab", tabId: tab.id })
                        }
                      >
                        Select
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Close ${tab.title || "tab"}`}
                        onClick={() =>
                          void action({ action: "close_tab", tabId: tab.id })
                        }
                      >
                        ×
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {ownControl && (
            <div className="mini-browser-controls">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const url = String(
                    new FormData(event.currentTarget).get("url") ?? "",
                  );
                  void action({ action: "navigate", url });
                }}
              >
                <label htmlFor="browser-url">Open website</label>
                <div className="mini-browser-actions">
                  <input
                    id="browser-url"
                    name="url"
                    type="url"
                    required
                    placeholder="https://example.com"
                    disabled={busy}
                  />
                  <button type="submit" disabled={busy}>
                    Open
                  </button>
                </div>
                <p className="mini-muted">
                  Opening a website grants your manual session access to that
                  origin.
                </p>
              </form>
              <div className="mini-browser-actions">
                <button
                  type="button"
                  disabled={busy || !pageBinding}
                  onClick={() =>
                    void act(
                      "operate",
                      {
                        command: "prepare_input",
                        generation: data.generation,
                        operationId: crypto.randomUUID(),
                        page: pageBinding,
                        kind: "text",
                      },
                      "Private input requested for the focused field.",
                    )
                  }
                >
                  Enter private value
                </button>
                <button
                  type="button"
                  disabled={busy || !pageBinding}
                  onClick={() => void action({ action: "press", key: "Tab" })}
                >
                  Tab
                </button>
                <button
                  type="button"
                  disabled={busy || !pageBinding}
                  onClick={() => void action({ action: "press", key: "Enter" })}
                >
                  Enter
                </button>
                <button
                  type="button"
                  disabled={busy || !pageBinding}
                  onClick={() =>
                    void action({ action: "scroll", x: 0, y: -500 })
                  }
                >
                  Scroll up
                </button>
                <button
                  type="button"
                  disabled={busy || !pageBinding}
                  onClick={() =>
                    void action({ action: "scroll", x: 0, y: 500 })
                  }
                >
                  Scroll down
                </button>
              </div>
            </div>
          )}
          {!!downloads.length && (
            <ul>
              {downloads.map((file) => (
                <li key={file.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void download(file.id)}
                  >
                    {file.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {data?.configured && (
          <section className="mini-browser-card">
            <h2>Saved login</h2>
            <p className="mini-muted">
              Closing keeps your saved login. Delete profile signs out all sites
              and removes this workspace’s browser files.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirm("delete")}
            >
              Delete profile
            </button>
          </section>
        )}
      </div>
      {confirm && (
        <Modal
          title={
            confirm === "takeover"
              ? "Take control?"
              : confirm === "close"
                ? "Close browser?"
                : "Delete profile?"
          }
          busy={busy}
          onClose={() => setConfirm(undefined)}
        >
          <p>
            {confirm === "takeover"
              ? "This interrupts current browser control and cancels an outstanding input request. Other tasks must wait until you return control."
              : confirm === "close"
                ? "Current browser requests stop. Your saved login remains available for the next task."
                : "This signs out all websites and permanently removes this browser profile and downloads. Existing task access is revoked."}
          </p>
          <ModalActions>
            <button
              type="button"
              className="mini-primary"
              disabled={busy}
              onClick={() => {
                setImage("");
                void act(
                  "operate",
                  confirm === "takeover"
                    ? { command: "takeover", revision: data?.revision }
                    : { command: confirm },
                  confirm === "delete"
                    ? "Profile deletion requested."
                    : confirm === "close"
                      ? "Browser close requested."
                      : "You have control.",
                );
              }}
            >
              {busy ? "Applying…" : "Confirm"}
            </button>
          </ModalActions>
        </Modal>
      )}
    </main>
  );
}
