import {
  createContext,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { type ActionIcon, IconButton } from "./icon-button.tsx";

export const ModalPending = createContext<
  ((pending: boolean) => void) | undefined
>(undefined);

/** Mount only while open; native modal dialogs keep the background inert. */
export function Modal({
  title,
  children,
  onClose,
  busy = false,
  cancelLabel = "Cancel",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  cancelLabel?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [pending, setPending] = useState(false);
  const locked = busy || pending;
  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement;
    element?.showModal();
    element
      ?.querySelector<HTMLElement>(
        "input:enabled, textarea:enabled, select:enabled",
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
      className="modal"
      aria-labelledby={titleId}
      aria-busy={locked}
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
        ).filter((control) => control.getClientRects().length > 0);
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
        <h2 id={titleId}>{title}</h2>
        <IconButton
          icon="close"
          label={`Close ${title}`}
          disabled={locked}
          onClick={onClose}
        />
      </header>
      <ModalPending.Provider value={setPending}>
        <fieldset className="modal-fields" disabled={locked}>
          {children}
        </fieldset>
      </ModalPending.Provider>
      <footer className="modal-footer">
        <button
          type="button"
          className="secondary"
          disabled={locked}
          onClick={onClose}
        >
          {cancelLabel}
        </button>
      </footer>
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
