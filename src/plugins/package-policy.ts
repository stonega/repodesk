import type { Run, Workspace } from "../domain.ts";

/** Applies to stored-result replay and delivery as well as active execution. */
export function packageReadAllowed(w: Workspace, run: Run): boolean {
  if (!run.packageRead) return true;
  return (
    (w.plugins?.revision ?? 0) === run.packageRead.revision &&
    Object.entries(run.packageRead.installations).every(([id, pin]) =>
      w.plugins?.packages?.some(
        (p) =>
          String(p.source.repositoryId) === id &&
          p.enabled &&
          p.digest === pin.digest &&
          p.generation === pin.generation,
      ),
    )
  );
}
