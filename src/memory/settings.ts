import type { Workspace } from "../domain.ts";
import type { MemoryState } from "./types.ts";

/** Missing settings adopt the product defaults; explicit saved choices win. */
export function preferenceSettings(
  w: Pick<Workspace, "memory">,
): NonNullable<MemoryState["preferenceSettings"]> {
  return {
    derive: w.memory?.preferenceSettings?.derive ?? true,
    recall: w.memory?.preferenceSettings?.recall ?? "pi_and_coding",
  };
}
