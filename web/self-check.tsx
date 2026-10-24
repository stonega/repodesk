import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  AlertCircle,
  ChatRoundCheck,
  Check,
  InfoCircle,
  Refresh,
} from "reicon-react";
import type { SelfCheckReply } from "../src/admin/self-check.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal } from "./modal.tsx";
import { ErrorToast } from "./toast.tsx";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  result?: SelfCheckReply;
};
type Request = <T>(
  path: string,
  method?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>;

const sectionNames: Record<string, string> = {
  "/admin/overview": "Overview",
  "/admin/settings": "Settings",
  "/admin/model": "Model settings",
  "/admin/operations": "Operations",
  "/admin/members": "Groups & Members",
  "/admin/skills": "Skills",
  "/admin/threads": "Threads",
};
function findingsLabel(result: SelfCheckReply) {
  const count = result.checks.filter(
    (check) => check.status === "warning",
  ).length;
  return count
    ? `${count} ${count === 1 ? "check needs" : "checks need"} attention`
    : "All checks passed";
}

export function SelfCheck({
  workspaceId,
  workspaceName,
  request,
}: {
  workspaceId: string;
  workspaceName: string;
  request: Request;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [failedMessage, setFailedMessage] = useState<string>();
  const active = useRef<AbortController | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (open && !pending) composer.current?.focus({ preventScroll: true });
  }, [open, pending]);
  useEffect(() => {
    void messages.length;
    void pending;
    if (open && transcript.current)
      transcript.current.scrollTop = messages.length
        ? transcript.current.scrollHeight
        : 0;
  }, [messages.length, pending, open]);

  async function send(content: string, retry = false) {
    const text = content.trim();
    if (!text || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError("");
    setFailedMessage(undefined);
    const prior = retry ? messages.slice(0, -1) : messages;
    if (!retry)
      setMessages((previous) => [
        ...previous,
        { id: crypto.randomUUID(), role: "user", content: text },
      ]);
    setDraft("");
    try {
      const result = await request<SelfCheckReply>(
        `/api/admin/workspaces/${workspaceId}/self-check`,
        "POST",
        {
          requestId: crypto.randomUUID(),
          message: text,
          history: prior.slice(-12).map(({ role, content }) => ({
            role,
            content: content.slice(0, 2000),
          })),
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setMessages((previous) => [
        ...previous,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: result.reply,
          result,
        },
      ]);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const code = cause instanceof Error ? cause.message : "";
      setError(
        code === "try_again_later"
          ? "Too many self-check requests. Please try again in a few minutes."
          : code === "self_check_busy"
            ? "A check is already running for this workspace. Please try again shortly."
            : code === "access_denied"
              ? "You no longer have admin access to this workspace."
              : "Couldn't complete the check. Your message is saved here; try again.",
      );
      setFailedMessage(text);
    } finally {
      if (!controller.signal.aborted) {
        active.current = null;
        setPending(false);
      }
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void send(draft);
  }
  return (
    <>
      <IconButton
        icon="chat"
        label="Open self-check assistant"
        className="self-check-launcher"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      />
      {open && (
        <Modal
          title="Self-check assistant"
          presentation="chat"
          onClose={() => setOpen(false)}
        >
          <p className="self-check-context">
            {workspaceName}{" "}
            <span className="self-check-context-note">· Read-only help</span>
          </p>
          <div
            ref={transcript}
            className="self-check-transcript"
            role="log"
            aria-label="Self-check conversation"
            aria-live="polite"
            aria-relevant="additions"
          >
            {messages.length === 0 && (
              <div className="self-check-welcome">
                <ChatRoundCheck size={32} weight="Outline" aria-hidden="true" />
                <h3>Let’s check your setup.</h3>
                <p>
                  I can check this workspace’s configuration and service status,
                  then help you understand what needs attention.
                </p>
                <button
                  type="button"
                  onClick={() =>
                    void send(
                      "Run a self-check and explain anything that needs attention.",
                    )
                  }
                >
                  Run self-check
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    void send(
                      "What should I check if the Telegram bot isn't replying?",
                    )
                  }
                >
                  Bot not replying?
                </button>
              </div>
            )}
            {messages.map((message) => (
              <article
                key={message.id}
                className={`self-check-message self-check-${message.role}`}
                aria-label={message.role === "user" ? "You" : "Assistant"}
              >
                <small className="self-check-speaker">
                  {message.role === "user" ? "You" : "RepoDesk"}
                </small>
                <p>{message.content}</p>
                {message.result && (
                  <>
                    <details className="self-check-findings">
                      <summary className="self-check-findings-toggle">
                        {findingsLabel(message.result)} · View findings
                      </summary>
                      <ul>
                        {message.result.checks.map((check) => {
                          const Icon =
                            check.status === "pass"
                              ? Check
                              : check.status === "warning"
                                ? AlertCircle
                                : InfoCircle;
                          return (
                            <li
                              key={check.name}
                              className={`self-check-finding self-check-${check.status}`}
                            >
                              <Icon
                                size={18}
                                weight="Outline"
                                aria-label={
                                  check.status === "pass"
                                    ? "Passed"
                                    : check.status === "warning"
                                      ? "Needs attention"
                                      : "Information"
                                }
                              />
                              <div>
                                <strong>{check.name}</strong>
                                <p>{check.detail}</p>
                                <Link
                                  to={`${check.path}?workspace=${encodeURIComponent(workspaceId)}`}
                                  onClick={() => setOpen(false)}
                                >
                                  Open {sectionNames[check.path] ?? "settings"}
                                </Link>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                      <small>
                        Checked{" "}
                        {new Date(
                          message.result.checkedAt,
                        ).toLocaleTimeString()}{" "}
                        · Saved setup and heartbeat only
                      </small>
                    </details>
                    {message.result.note && (
                      <p className="self-check-note">{message.result.note}</p>
                    )}
                  </>
                )}
              </article>
            ))}
            {pending && (
              <p className="self-check-pending" role="status">
                <Refresh
                  size={16}
                  weight="Outline"
                  className="icon-spinning"
                  aria-hidden="true"
                />
                Checking your workspace…
              </p>
            )}
            {failedMessage && !pending && (
              <div className="self-check-retry">
                <p>Your last message couldn’t be checked.</p>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => void send(failedMessage, true)}
                >
                  Retry message
                </button>
              </div>
            )}
          </div>
          <form className="self-check-composer" onSubmit={submit}>
            <label className="self-check-label" htmlFor="self-check-message">
              Ask about your setup
            </label>
            <div className="self-check-input-row">
              <textarea
                ref={composer}
                id="self-check-message"
                rows={2}
                maxLength={4000}
                placeholder="What would you like to check?"
                value={draft}
                disabled={pending}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void send(draft);
                  }
                }}
              />
              <IconButton
                icon="latest"
                label="Send message"
                type="submit"
                disabled={pending || !draft.trim()}
                busy={pending}
              />
            </div>
            <small className="self-check-privacy">
              Checks are read-only. Keep passwords and API keys out of chat.
            </small>
          </form>
          <ErrorToast message={error}>
            {failedMessage && (
              <button
                type="button"
                onClick={() => void send(failedMessage, true)}
              >
                Retry
              </button>
            )}
          </ErrorToast>
        </Modal>
      )}
    </>
  );
}
