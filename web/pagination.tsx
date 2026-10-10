import type { ReactNode } from "react";
import { IconButton } from "./icon-button.tsx";
import { Skeleton } from "./skeleton.tsx";

export function Pagination({
  children,
  loading = false,
  previousDisabled,
  nextDisabled,
  onPrevious,
  onNext,
  className = "",
}: {
  children: ReactNode;
  loading?: boolean;
  previousDisabled: boolean;
  nextDisabled: boolean;
  onPrevious: () => void;
  onNext: () => void;
  className?: string;
}) {
  return (
    <nav className={`row pagination ${className}`} aria-label="Pagination">
      <IconButton
        icon="previous"
        label="Previous page"
        disabled={loading || previousDisabled}
        onClick={onPrevious}
      />
      <span aria-live="polite" aria-busy={loading}>
        {loading ? <Skeleton width="8rem" /> : children}
      </span>
      <IconButton
        icon="next"
        label="Next page"
        disabled={loading || nextDisabled}
        onClick={onNext}
      />
    </nav>
  );
}
