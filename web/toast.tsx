import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Check } from "reicon-react";
import { IconButton } from "./icon-button.tsx";

const ToastContext = createContext<{
  notify: (message: string) => void;
  dismiss: () => void;
} | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("ToastProvider is required");
  return context.notify;
}

/** Keep confirmations visible through summary reloads and navigation. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ id: number; message: string }>();
  const sequence = useRef(0);
  const notify = useCallback((message: string) => {
    setToast({ id: ++sequence.current, message });
  }, []);
  const dismiss = useCallback(() => setToast(undefined), []);
  return (
    <ToastContext.Provider value={{ notify, dismiss }}>
      {children}
      {toast &&
        createPortal(
          <Toast key={toast.id} message={toast.message} dismiss={dismiss} />,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

/** Page errors float above the layout; retry controls remain part of the toast. */
export function ErrorToast({
  message,
  children,
}: {
  message: string;
  children?: ReactNode;
}) {
  const context = useContext(ToastContext);
  if (!context) throw new Error("ToastProvider is required");
  const [dismissedMessage, setDismissedMessage] = useState<string>();
  const dismiss = useCallback(() => setDismissedMessage(message), [message]);
  const dismissConfirmation = context.dismiss;
  useEffect(() => {
    if (!message) return;
    setDismissedMessage(undefined);
    dismissConfirmation();
  }, [dismissConfirmation, message]);
  return !message || dismissedMessage === message
    ? null
    : createPortal(
        <Toast key={message} message={message} dismiss={dismiss} error>
          {children}
        </Toast>,
        document.body,
      );
}

function Toast({
  message,
  dismiss,
  error = false,
  children,
}: {
  message: string;
  dismiss: () => void;
  error?: boolean;
  children?: ReactNode;
}) {
  const hovered = useRef(false);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pause = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const resume = useCallback(() => {
    pause();
    if (!error && !hovered.current && !focused.current)
      timer.current = setTimeout(dismiss, 6000);
  }, [dismiss, error, pause]);
  useEffect(() => {
    resume();
    return pause;
  }, [resume, pause]);
  const Icon = error ? AlertCircle : Check;
  return (
    <section
      className={`toast${error ? " toast-error" : ""}`}
      aria-label="Notification"
      onPointerEnter={() => {
        hovered.current = true;
        pause();
      }}
      onPointerLeave={() => {
        hovered.current = false;
        resume();
      }}
      onFocus={() => {
        focused.current = true;
        pause();
      }}
      onBlur={() => {
        focused.current = false;
        resume();
      }}
    >
      <Icon
        className="toast-icon"
        size={20}
        weight="Outline"
        aria-hidden="true"
      />
      <div className="toast-content">
        <p
          role={error ? "alert" : "status"}
          aria-live={error ? "assertive" : "polite"}
          aria-atomic="true"
        >
          {error &&
          [
            "Failed to fetch",
            "Load failed",
            "NetworkError when attempting to fetch resource.",
          ].includes(message)
            ? "Couldn’t connect to RepoDesk."
            : message}
        </p>
      </div>
      {children && <div className="toast-actions">{children}</div>}
      <IconButton icon="close" label="Dismiss notification" onClick={dismiss} />
    </section>
  );
}
