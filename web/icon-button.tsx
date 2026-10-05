import type { ButtonHTMLAttributes } from "react";
import {
  Add,
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  CloseCircle,
  Copy,
  DocumentUpload,
  Edit,
  Logout,
  Pause,
  Play,
  Refresh,
  Search,
  Stop,
  Trash,
} from "reicon-react";

const icons = {
  add: Add,
  archive: Archive,
  previous: ChevronLeft,
  next: ChevronRight,
  close: CloseCircle,
  copy: Copy,
  done: Check,
  edit: Edit,
  import: DocumentUpload,
  logout: Logout,
  pause: Pause,
  play: Play,
  refresh: Refresh,
  search: Search,
  stop: Stop,
  delete: Trash,
  latest: ArrowUp,
  older: ArrowDown,
};
export type ActionIcon = keyof typeof icons;

type IconButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "aria-label" | "title"
> & {
  icon: ActionIcon;
  label: string;
  busy?: boolean;
  showLabel?: boolean;
};

/** Keep the action's accessible name stable while a request is in flight. */
export function IconButton({
  icon,
  label,
  busy = false,
  showLabel = false,
  disabled,
  className = "",
  type = "button",
  ...props
}: IconButtonProps) {
  const Icon = busy ? Refresh : icons[icon];
  const actionLabel = icon === "edit" ? "Edit" : icon === "add" ? "New" : label;
  return (
    <button
      {...props}
      type={type}
      className={`icon-button${showLabel ? " with-label" : ""} ${className}`}
      aria-label={label}
      title={busy ? `${actionLabel} — Working…` : actionLabel}
      aria-busy={busy}
      disabled={disabled || busy}
    >
      <Icon
        size={20}
        weight="Outline"
        color="currentColor"
        aria-hidden="true"
        focusable="false"
        className={busy ? "icon-spinning" : undefined}
      />
      {showLabel && <span>{actionLabel}</span>}
    </button>
  );
}
