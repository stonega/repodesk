import type { Delivery } from "../domain.ts";

export type TaskOwner = "run" | "coding" | "development";

/** GitHub handles review and merge permissions and confirmation on the PR itself. */
export function pullRequestButtons(url?: string): Delivery["buttons"] {
  if (!url) return;
  return [
    [
      { text: "Review", url: `${url}/files` },
      { text: "Merge", url },
    ],
  ];
}

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
