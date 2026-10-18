import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import type { HistoryItem, TaskHistory } from "../src/miniapp/history.ts";
import { MiniMarkdown } from "./mini-markdown.tsx";

type TelegramApp = {
  initData: string;
  initDataUnsafe?: { start_param?: string };
  colorScheme?: string;
  themeParams?: Record<string, string>;
  viewportStableHeight?: number;
  isActive?: boolean;
  safeAreaInset?: Record<string, number>;
  contentSafeAreaInset?: Record<string, number>;
  ready(): void;
  expand(): void;
  BackButton?: { hide(): void };
  MainButton?: { hide(): void };
  onEvent(name: string, handler: () => void): void;
  offEvent(name: string, handler: () => void): void;
};
declare global {
  interface Window {
    Telegram?: { WebApp: TelegramApp };
  }
}
const app = window.Telegram?.WebApp;
const reference =
  app?.initDataUnsafe?.start_param ||
  new URLSearchParams(location.search).get("tgWebAppStartParam") ||
  "";
const names: Record<HistoryItem["role"], string> = {
  user: "User",
  chat_agent: "Chat Agent",
  codex: "Codex",
  activity: "Activity",
};
const errors: Record<string, string> = {
  miniapp_auth_required:
    "Open this conversation from its Telegram task message.",
  miniapp_auth_invalid:
    "Your Telegram session could not be verified. Reopen the task in Telegram.",
  miniapp_auth_expired:
    "Your session has expired. Reopen the task in Telegram.",
  miniapp_history_expired:
    "This conversation is no longer available under the workspace’s retention policy.",
  access_denied: "You no longer have access to this conversation.",
  destination_denied: "This chat is no longer connected.",
  miniapp_task_unavailable: "This task conversation is no longer available.",
  not_found: "This task conversation is no longer available.",
};
const Message = memo(function Message({ item }: { item: HistoryItem }) {
  return (
    <article
      className={`mini-message mini-${item.role}`}
      data-message-id={item.id}
    >
      <div className="mini-message-meta">
        <strong>
          {item.author ?? names[item.role]}
          {item.role !== "activity" && item.title ? ` · ${item.title}` : ""}
        </strong>
        <time dateTime={item.at}>
          {new Date(item.at).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </div>
      {item.role === "activity" ? (
        <details>
          <summary>{item.title || "Tool activity"}</summary>
          <pre>{item.text}</pre>
        </details>
      ) : (
        <MiniMarkdown text={item.text} />
      )}
      {item.truncated && (
        <p className="mini-muted">
          This message exceeded the display limit. The recorded excerpt is
          shown.
        </p>
      )}
      {item.state && (
        <span className="mini-receipt">
          {(
            {
              queued: "Queued",
              accepted: "Accepted by Codex",
              read: "Read by Codex",
              answered: "Answered",
              unknown: "Delivery unconfirmed",
              cancelled: "Cancelled",
            } as Record<string, string>
          )[item.state] ?? "Pending"}
        </span>
      )}
    </article>
  );
});
function MiniApp() {
  const [history, setHistory] = useState<TaskHistory>();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [error, setError] = useState("");
  const [fatal, setFatal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [olderBusy, setOlderBusy] = useState(false);
  const [newMessages, setNewMessages] = useState(false);
  const view = useRef<HTMLElement>(null);
  const current = useRef<HistoryItem[]>([]);
  const follow = useRef(true);
  const restore = useRef<{ height: number; top: number } | undefined>(
    undefined,
  );
  const after = useRef<string | undefined>(undefined);
  const before = useRef<string | undefined>(undefined);
  const busy = useRef(false);
  const mounted = useRef(true);
  const controller = useRef<AbortController | undefined>(undefined);
  const request = useCallback(
    async (paging: { before?: string; after?: string } = {}) => {
      const response = await fetch("/mini-api/history", {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initData: app?.initData ?? "",
          reference,
          ...paging,
        }),
        signal: controller.current?.signal,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const blocked = [400, 401, 403, 404, 409, 410].includes(
          response.status,
        );
        if (blocked && mounted.current) {
          setFatal(true);
          setHistory(undefined);
          setItems([]);
          current.current = [];
        }
        throw Error(
          errors[data.error] ??
            (blocked
              ? "This conversation is unavailable. Reopen it from Telegram."
              : "Couldn’t update the conversation. Retrying…"),
        );
      }
      return (await response.json()) as TaskHistory;
    },
    [],
  );
  const merge = useCallback((incoming: HistoryItem[], prepend = false) => {
    const container = view.current;
    if (prepend && container)
      restore.current = {
        height: container.scrollHeight,
        top: container.scrollTop,
      };
    const saved = new Map(current.current.map((item) => [item.id, item]));
    let added = false;
    for (const item of incoming) {
      if (!saved.has(item.id)) added = true;
      saved.set(item.id, item);
    }
    const next = [...saved.values()].sort(
      (a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id),
    );
    current.current = next;
    setItems(next);
    if (added && !prepend && !follow.current) setNewMessages(true);
  }, []);
  const refresh = useCallback(async () => {
    if (
      busy.current ||
      !app?.initData ||
      !reference ||
      app.isActive === false ||
      document.hidden
    )
      return;
    busy.current = true;
    try {
      let latest = await request(after.current ? { after: after.current } : {});
      if (!mounted.current) return;
      const initial = !after.current;
      merge(latest.items);
      if (initial) before.current = latest.before;
      after.current = latest.after ?? after.current;
      // Drain missed pages after a minimized/offline interval before resuming normal polling.
      while (!initial && latest.hasMore && mounted.current) {
        latest = await request({ after: after.current });
        if (!mounted.current) return;
        merge(latest.items);
        after.current = latest.after ?? after.current;
      }
      if (!initial) {
        const newest = await request();
        if (!mounted.current) return;
        merge(newest.items);
        latest = { ...newest, hasMore: history?.hasMore ?? false };
      }
      setHistory((prior) => ({
        ...latest,
        hasMore: initial ? latest.hasMore : (prior?.hasMore ?? false),
      }));
      setError("");
    } catch (e) {
      if (
        mounted.current &&
        !(e instanceof DOMException && e.name === "AbortError")
      )
        setError(
          e instanceof Error ? e.message : "Couldn’t load this conversation.",
        );
    } finally {
      busy.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [request, merge, history?.hasMore]);
  useEffect(() => {
    mounted.current = true;
    controller.current = new AbortController();
    const syncTheme = () => {
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
    syncTheme();
    app?.BackButton?.hide();
    app?.MainButton?.hide();
    app?.ready();
    app?.expand();
    for (const event of [
      "themeChanged",
      "viewportChanged",
      "safeAreaChanged",
      "contentSafeAreaChanged",
    ])
      app?.onEvent(event, syncTheme);
    return () => {
      for (const event of [
        "themeChanged",
        "viewportChanged",
        "safeAreaChanged",
        "contentSafeAreaChanged",
      ])
        app?.offEvent(event, syncTheme);
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (fatal) return;
    if (!app?.initData || !reference) {
      setError("Open this conversation from its Telegram task message.");
      setLoading(false);
      return;
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    const wake = () => void refresh();
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    app.onEvent("activated", wake);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      app.offEvent("activated", wake);
    };
  }, [refresh, fatal]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Restore the scroll anchor after the message DOM changes.
  useLayoutEffect(() => {
    const container = view.current;
    if (!container) return;
    if (restore.current) {
      container.scrollTop =
        restore.current.top + container.scrollHeight - restore.current.height;
      restore.current = undefined;
    } else if (follow.current) container.scrollTop = container.scrollHeight;
  }, [items]);
  const older = async () => {
    if (olderBusy || busy.current) return;
    setOlderBusy(true);
    busy.current = true;
    try {
      const result = await request({ before: before.current });
      if (!mounted.current) return;
      before.current = result.before;
      merge(result.items, true);
      setHistory((prior) =>
        prior ? { ...prior, hasMore: result.hasMore } : result,
      );
      setError("");
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error ? e.message : "Couldn’t load earlier messages.",
        );
    } finally {
      busy.current = false;
      if (mounted.current) setOlderBusy(false);
    }
  };
  return (
    <main className="mini-shell">
      <header className="mini-heading">
        <span className="mini-eyebrow">RepoDesk · Codex</span>
        <h1>{history?.task.title || "Task conversation"}</h1>
        {history && (
          <>
            <p className="mini-repository">{history.task.repository}</p>
            <p className="mini-status">
              <span aria-hidden="true" />
              {history.task.status}
            </p>
          </>
        )}
      </header>
      {error && (
        <div role="alert" className="mini-error">
          {error}
          {!fatal && !loading && app?.initData && reference && (
            <button type="button" onClick={() => void refresh()}>
              Retry now
            </button>
          )}
        </div>
      )}
      <section
        ref={view}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The transcript region supports keyboard scrolling.
        tabIndex={0}
        className="mini-timeline"
        aria-label="Task messages"
        onScroll={() => {
          const el = view.current;
          if (el) {
            follow.current =
              el.scrollHeight - el.clientHeight - el.scrollTop < 60;
            if (follow.current) setNewMessages(false);
          }
        }}
      >
        {loading && (
          <p role="status" className="mini-placeholder">
            Loading conversation…
          </p>
        )}
        {history && (
          <>
            <p className="mini-coverage">
              {history.recordingAvailable
                ? "Recorded Codex messages and task exchanges. Interrupted partial output may be unavailable."
                : "Earlier Codex messages were not recorded. Available task exchanges are shown."}
            </p>
            {history.hasMore && (
              <button
                className="mini-older"
                type="button"
                disabled={olderBusy}
                onClick={() => void older()}
              >
                {olderBusy
                  ? "Loading earlier messages…"
                  : "Load earlier messages"}
              </button>
            )}
          </>
        )}
        {!loading && history && !items.length && (
          <p className="mini-placeholder">
            No messages yet. They’ll appear here as the task progresses.
          </p>
        )}
        {items.map((item) => (
          <Message key={item.id} item={item} />
        ))}
      </section>
      {newMessages && (
        <button
          type="button"
          className="mini-new"
          onClick={() => {
            follow.current = true;
            setNewMessages(false);
            const el = view.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          New messages ↓
        </button>
      )}
      {history?.task.prUrl &&
        /^https:\/\/github\.com\//.test(history.task.prUrl) && (
          <footer className="mini-footer">
            <a
              href={history.task.prUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open pull request ↗
            </a>
          </footer>
        )}
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<MiniApp />);
