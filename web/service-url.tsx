import { useEffect, useState } from "react";
import { IconButton } from "./icon-button.tsx";
import { Skeleton } from "./skeleton.tsx";

export function ServiceUrl({
  label,
  value,
  loading = false,
}: {
  label: string;
  value?: string;
  loading?: boolean;
}) {
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(
    null,
  );
  const [copying, setCopying] = useState(false);
  useEffect(() => {
    if (copyStatus !== "copied") return;
    const timer = setTimeout(() => setCopyStatus(null), 1000);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  return (
    <div className="service-url">
      <dt>{label}</dt>
      <dd>
        <div className="service-url-value">
          {value ? (
            <code>{value}</code>
          ) : loading ? (
            <Skeleton width="20rem" />
          ) : (
            <span>—</span>
          )}
          <IconButton
            icon={copyStatus === "copied" ? "done" : "copy"}
            label={`${copyStatus === "copied" ? "Copied" : "Copy"} ${label}`}
            disabled={!value || copyStatus === "copied"}
            busy={copying}
            onClick={async () => {
              if (!value) return;
              setCopying(true);
              setCopyStatus(null);
              try {
                await navigator.clipboard.writeText(value);
                setCopyStatus("copied");
              } catch {
                setCopyStatus("failed");
              } finally {
                setCopying(false);
              }
            }}
          />
        </div>
        {copyStatus === "failed" && (
          <p className="error" role="alert">
            Could not copy. Select the URL to copy it manually.
          </p>
        )}
      </dd>
    </div>
  );
}
