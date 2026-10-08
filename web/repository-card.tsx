import type { ReactNode } from "react";
import { ArrowUpRightSquare } from "reicon-react";

export function RepositoryCard({
  name,
  url,
  compact = false,
  label = name,
  metadata,
  actions,
  children,
}: {
  name: string;
  url?: string;
  compact?: boolean;
  label?: string;
  metadata?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const Name = compact ? "span" : "h3";
  return (
    <article
      className={`repository-card${compact ? " repository-card-compact" : ""}`}
      aria-label={label}
    >
      <div className="repository-card-heading">
        <div className="repository-card-identity">
          <Name className="repository-card-name">{name}</Name>
          {metadata && <> {metadata}</>}
        </div>
        {(url || actions) && (
          <div className="repository-card-actions">
            {url && (
              <a
                className="repository-card-link"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${name} on GitHub`}
                title={`Open ${name} on GitHub`}
              >
                <ArrowUpRightSquare
                  size={18}
                  weight="Outline"
                  color="currentColor"
                  aria-hidden="true"
                  focusable="false"
                />
              </a>
            )}
            {actions}
          </div>
        )}
      </div>
      {children && <div className="repository-card-details">{children}</div>}
    </article>
  );
}
