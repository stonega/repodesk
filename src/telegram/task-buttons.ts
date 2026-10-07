import type { Delivery } from "../domain.ts";

export type TaskOwner = "run" | "coding" | "development";

/** Short references only; sent delivery records and current policy authorize taps. */
export function taskButtons(
  owner: TaskOwner,
  id: string,
  cancel = true,
): Delivery["buttons"] {
  const kind = { run: "r", coding: "c", development: "d" }[owner];
  return [
    [
      { text: "Status", callback_data: `t${kind}s:${id}` },
      ...(cancel ? [{ text: "Cancel", callback_data: `t${kind}c:${id}` }] : []),
    ],
  ];
}
