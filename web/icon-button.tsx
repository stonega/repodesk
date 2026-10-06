import type { ButtonHTMLAttributes, SVGProps } from "react";
import {
  Add,
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  DocumentUpload,
  Edit,
  Logout,
  Moon,
  Pause,
  Play,
  Refresh,
  Search,
  Stop,
  Sun,
  Trash6,
} from "reicon-react";

function CloseIcon({
  size = 20,
  weight: _weight,
  ...props
}: SVGProps<SVGSVGElement> & { size?: number; weight?: "Outline" }) {
  return (
    <svg
      {...props}
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 6 12 12M6 18 18 6" />
    </svg>
  );
}

const icons = {
  add: Add,
  archive: Archive,
  previous: ChevronLeft,
  next: ChevronRight,
  close: CloseIcon,
  copy: Copy,
  done: Check,
  edit: Edit,
  import: DocumentUpload,
  logout: Logout,
  moon: Moon,
  sun: Sun,
  pause: Pause,
  play: Play,
  refresh: Refresh,
  search: Search,
  stop: Stop,
  delete: Trash6,
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
      className={`icon-button${showLabel ? " with-label" : ""}${icon === "delete" ? " danger" : ""} ${className}`}
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
