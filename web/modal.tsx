import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { type ActionIcon, IconButton } from "./icon-button.tsx";

export const ModalPending = createContext<
  ((pending: boolean) => void) | undefined
>(undefined);

const ModalControls = createContext<{
  onClose: () => void;
  locked: boolean;
  cancelLabel: string;
} | null>(null);

/** Keep primary and cancel actions together inside the owning form/dialog. */
export function ModalActions({ children }: { children: ReactNode }) {
  const controls = useContext(ModalControls);
  if (!controls) return <>{children}</>;
  return (
    <div className="modal-actions">
      {children}
      <button
        type="button"
        className="secondary"
        disabled={controls.locked}
        onClick={controls.onClose}
      >
        {controls.cancelLabel}
      </button>
    </div>
  );
}

/** Mount only while open; native modal dialogs keep the background inert. */
export function Modal({
  title,
  children,
  onClose,
  busy = false,
  cancelLabel = "Cancel",
  presentation = "dialog",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  cancelLabel?: string;
  presentation?: "dialog" | "sheet";
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const locked = busy || pending;
  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement;
    element?.showModal();
    element
      ?.querySelector<HTMLElement>(
        "input:enabled, textarea:enabled, select:enabled:not([hidden]), button[role=combobox]:enabled",
      )
      ?.focus();
    return () => {
      element?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus();
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className={`modal${presentation === "sheet" ? " navigation-sheet" : ""}`}
      aria-label={title}
      aria-busy={locked}
      onClick={(event) => {
        if (presentation !== "sheet" || locked) return;
        if (
          event.target instanceof Element &&
          event.target.closest("a[href]")
        ) {
          onClose();
          return;
        }
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onClose();
      }}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!locked) onClose();
      }}
      onSubmit={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (
          event.key !== "Tab" ||
          !(event.target instanceof Element) ||
          event.target.closest("dialog") !== event.currentTarget
        )
          return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:enabled, input:enabled, textarea:enabled, select:enabled, a[href], [tabindex]:not([tabindex="-1"])',
          ),
        ).filter(
          (control) =>
            control.tabIndex >= 0 && control.getClientRects().length > 0,
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (!first || !last) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <header className="modal-heading">
        <h2>{title}</h2>
        <IconButton
          icon="close"
          label={`Close ${title}`}
          disabled={locked}
          onClick={onClose}
        />
      </header>
      <ModalPending.Provider value={setPending}>
        <ModalControls.Provider value={{ onClose, locked, cancelLabel }}>
          <fieldset className="modal-fields" disabled={locked}>
            {children}
          </fieldset>
        </ModalControls.Provider>
      </ModalPending.Provider>
    </dialog>,
    document.body,
  );
}

export function CreateModal({
  label,
  title = label,
  icon = "add",
  children,
}: {
  label: string;
  title?: string;
  icon?: ActionIcon;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <IconButton icon={icon} label={label} onClick={() => setOpen(true)} />
      {open && (
        <Modal title={title} onClose={close}>
          {children(close)}
        </Modal>
      )}
    </>
  );
}
