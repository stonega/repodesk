/** Decorative placeholders; the containing region provides its name and busy state. */
export function Skeleton({
  width = "100%",
  height = "1em",
}: {
  width?: string;
  height?: string;
}) {
  return (
    <span className="skeleton" style={{ width, height }} aria-hidden="true" />
  );
}

export function SkeletonRows({
  label,
  rows = 3,
}: {
  label: string;
  rows?: number;
}) {
  return (
    <div className="skeleton-rows" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Static decorative placeholders.
        <div className="skeleton-row" key={index} aria-hidden="true">
          <Skeleton width="64%" />
          <Skeleton width="42%" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonCells({
  columns,
  rows = 3,
}: {
  columns: number;
  rows?: number;
}) {
  return Array.from({ length: rows }, (_, row) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: Static decorative placeholders.
    <tr key={row}>
      {Array.from({ length: columns }, (_, column) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Static decorative placeholders.
        <td key={column}>
          <Skeleton />
        </td>
      ))}
    </tr>
  ));
}
