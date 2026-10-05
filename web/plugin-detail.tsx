import type { ReactNode } from "react";
import { Link } from "react-router";
import { ChevronLeft } from "reicon-react";
import { Skeleton } from "./skeleton.tsx";

export function PluginToggle({
  name,
  enabled,
  disabled,
  loading = enabled === undefined,
  onChange,
}: {
  name: string;
  enabled: boolean | undefined;
  disabled: boolean;
  loading?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  if (enabled === undefined)
    return (
      <div
        className="plugin-toggle"
        role="status"
        aria-busy={loading}
        aria-label={`Enable ${name}`}
      >
        <span>Enable</span>
        {loading ? (
          <Skeleton width="44px" height="26px" />
        ) : (
          <span className="muted">—</span>
        )}
      </div>
    );
  return (
    <label className="plugin-toggle">
      <span>Enable</span>
      <input
        className="plugin-toggle-input"
        type="checkbox"
        role="switch"
        aria-checked={enabled}
        aria-label={`Enable ${name}`}
        checked={enabled}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

export function PluginDetailHeading({
  title,
  backTo,
  children,
}: {
  title: string;
  backTo: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <p className="eyebrow">
        <Link className="plugin-back-link" to={backTo}>
          <ChevronLeft
            size={18}
            weight="Outline"
            color="currentColor"
            aria-hidden="true"
          />
          <span>Plugins</span>
        </Link>
      </p>
      <div className="plugin-detail-title">
        <h1>{title}</h1>
        {children}
      </div>
    </header>
  );
}
