import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, Refresh } from "reicon-react";
import { DropdownPopup } from "./dropdown-popup.tsx";

const intervals = [
  { value: 10000, label: "10s", description: "Every 10 seconds" },
  { value: 30000, label: "30s", description: "Every 30 seconds" },
  { value: 60000, label: "1m", description: "Every minute" },
  { value: 300000, label: "5m", description: "Every 5 minutes" },
  { value: 0, label: "Off", description: "Off" },
];

export function LogRefresh({
  interval,
  loading,
  onIntervalChange,
  onRefresh,
}: {
  interval: number;
  loading: boolean;
  onIntervalChange: (interval: number) => void;
  onRefresh: () => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const dismiss = useCallback(() => setOpen(false), []);
  const close = () => {
    dismiss();
    trigger.current?.focus();
  };
  useEffect(() => {
    if (open)
      menu.current
        ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
        ?.focus();
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        className="dropdown-trigger log-refresh-trigger"
        aria-label="Auto-refresh"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>
          Auto-refresh:{" "}
          {intervals.find((item) => item.value === interval)?.label}
        </span>
      </button>
      {open && (
        <DropdownPopup
          anchor={trigger}
          onDismiss={dismiss}
          minWidth={250}
          preferredHeight={320}
        >
          <div
            ref={menu}
            id={`${id}-menu`}
            role="menu"
            aria-labelledby={id}
            className="log-refresh-menu"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
              } else if (event.key === "Tab") close();
              else if (
                ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
              ) {
                event.preventDefault();
                const items = Array.from(
                  menu.current?.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  ) ?? [],
                );
                const active = items.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                const index =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : (active +
                          (event.key === "ArrowUp" ? -1 : 1) +
                          items.length) %
                        items.length;
                items[index]?.focus();
              }
            }}
          >
            <div className="dropdown-group">Auto-refresh</div>
            {intervals.map((item) => (
              <button
                key={item.value}
                type="button"
                role="menuitemradio"
                aria-checked={interval === item.value}
                tabIndex={-1}
                className="dropdown-item"
                onClick={() => {
                  onIntervalChange(item.value);
                  close();
                }}
              >
                <span className="log-refresh-check">
                  {interval === item.value && (
                    <Check size={18} aria-hidden="true" />
                  )}
                </span>
                <span>{item.description}</span>
              </button>
            ))}
            <hr className="log-refresh-divider" />
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="dropdown-item"
              disabled={loading}
              onClick={() => {
                onRefresh();
                close();
              }}
            >
              <Refresh size={18} aria-hidden="true" />
              <span>Refresh now</span>
            </button>
          </div>
        </DropdownPopup>
      )}
    </>
  );
}
