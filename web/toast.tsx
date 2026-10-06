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
import { Check } from "reicon-react";
import { IconButton } from "./icon-button.tsx";

const ToastContext = createContext<((message: string) => void) | null>(null);

export function useToast() {
  const notify = useContext(ToastContext);
  if (!notify) throw new Error("ToastProvider is required");
  return notify;
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
    <ToastContext.Provider value={notify}>
      {children}
      {toast &&
        createPortal(
          <Toast key={toast.id} message={toast.message} dismiss={dismiss} />,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

function Toast({ message, dismiss }: { message: string; dismiss: () => void }) {
  const hovered = useRef(false);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pause = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const resume = useCallback(() => {
    pause();
    if (!hovered.current && !focused.current)
      timer.current = setTimeout(dismiss, 6000);
  }, [dismiss, pause]);
  useEffect(() => {
    resume();
    return pause;
  }, [resume, pause]);
  return (
    <section
      className="toast"
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
      <Check
        className="toast-icon"
        size={22}
        weight="Outline"
        aria-hidden="true"
      />
      <p role="status" aria-live="polite" aria-atomic="true">
        {message}
      </p>
      <IconButton icon="close" label="Dismiss notification" onClick={dismiss} />
    </section>
  );
}
