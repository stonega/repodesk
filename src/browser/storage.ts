import type { BrowserReadStamp, Workspace } from "../domain.ts";
import { Fault, requireThat } from "../domain.ts";
import { decrypt, encrypt } from "../setup/credentials.ts";
import { browserPrivateGrants } from "./privacy.ts";

type PrivateRecord = Record<string, unknown> & {
  browserSealed?: string;
  browserRead?: BrowserReadStamp;
};
const runFields = [
  "task",
  "sources",
  "instructions",
  "transcript",
  "tools",
  "result",
  "contextSummary",
  "compaction",
  "discussionUpdates",
  "pendingInputs",
  "followup",
  "memoryContext",
  "handoffRead",
];
const sourceFields = ["text", "attachments"];
const threadFields = ["summary", "discussions"];
const deliveryFields = ["text", "buttons", "sentButtons"];
const approvalFields = ["payload"];
const record = (value: object) => value as PrivateRecord;
const name = (w: Workspace, kind: string, id: string, owner: string) =>
  `browser-content:${w.id}:${owner}:${kind}:${id}`;

function seal(
  value: PrivateRecord,
  fields: string[],
  aad: string,
  key: string,
  placeholder: Record<string, unknown>,
) {
  const body: Record<string, unknown> = {};
  for (const field of fields)
    if (Object.hasOwn(value, field)) body[field] = value[field];
  value.browserSealed = encrypt(key, aad, JSON.stringify(body));
  for (const field of fields) delete value[field];
  Object.assign(value, placeholder);
}
function unseal(
  value: PrivateRecord,
  fields: string[],
  aad: string,
  key?: string,
) {
  if (!value.browserSealed) return;
  requireThat(key, "browser_private_storage_unavailable", 503);
  try {
    const body = JSON.parse(decrypt(key, aad, value.browserSealed));
    requireThat(
      body && typeof body === "object" && !Array.isArray(body),
      "browser_private_storage_unavailable",
      503,
    );
    for (const field of fields) {
      delete value[field];
      if (Object.hasOwn(body, field)) value[field] = body[field];
    }
    delete value.browserSealed;
  } catch {
    throw new Fault("browser_private_storage_unavailable", 503);
  }
}

/** Keep queryable run/queue metadata, encrypt all private browser conversation bodies. */
export function encodeBrowserWorkspace(
  workspace: Workspace,
  key?: string,
): Workspace {
  const hasPrivate =
    workspace.runs.some((run) => browserPrivateGrants(workspace, run).length) ||
    workspace.messages.some((source) => source.browserRead) ||
    workspace.threads?.some((thread) => thread.browserRead) ||
    workspace.deliveries.some((delivery) => delivery.browserRead) ||
    workspace.approvals.some((approval) => approval.browserRead);
  if (!hasPrivate) return workspace;
  requireThat(key, "browser_private_storage_unavailable", 503);
  const w = structuredClone(workspace);
  const privateRuns = new Map(
    w.runs.flatMap((run) => {
      const stamp = browserPrivateGrants(workspace, run)[0];
      if (!stamp) return [];
      run.browserRead ??= structuredClone(stamp);
      return [[run.id, run.browserRead] as const];
    }),
  );
  for (const run of w.runs) {
    if (!run.browserRead) continue;
    seal(
      record(run),
      runFields,
      name(w, "run", run.id, run.browserRead.owner),
      key,
      {
        task: "Private browser task",
        sources: [],
        instructions: [],
        transcript: [],
        tools: {},
      },
    );
  }
  for (const source of w.messages) {
    source.browserRead ??= source.runId
      ? privateRuns.get(source.runId)
      : undefined;
    if (source.browserRead)
      seal(
        record(source),
        sourceFields,
        name(w, "source", source.id, source.browserRead.owner),
        key,
        { text: "Private browser message" },
      );
  }
  for (const thread of w.threads ?? []) {
    thread.browserRead ??= w.runs.find(
      (run) => run.threadId === thread.id && run.browserRead,
    )?.browserRead;
    if (thread.browserRead)
      seal(
        record(thread),
        threadFields,
        name(w, "thread", thread.id, thread.browserRead.owner),
        key,
        {},
      );
  }
  for (const delivery of w.deliveries) {
    delivery.browserRead ??= privateRuns.get(
      delivery.runId ?? delivery.cancellationRunId ?? "",
    );
    if (delivery.browserRead)
      seal(
        record(delivery),
        deliveryFields,
        name(w, "delivery", delivery.id, delivery.browserRead.owner),
        key,
        { text: "Private browser message" },
      );
  }
  for (const approval of w.approvals) {
    approval.browserRead ??= approval.runId
      ? privateRuns.get(approval.runId)
      : undefined;
    if (approval.browserRead)
      seal(
        record(approval),
        approvalFields,
        name(w, "approval", approval.id, approval.browserRead.owner),
        key,
        { payload: {} },
      );
  }
  return w;
}

export function decodeBrowserWorkspace(w: Workspace, key?: string): Workspace {
  for (const [kind, values, fields] of [
    ["run", w.runs, runFields],
    ["source", w.messages, sourceFields],
    ["thread", w.threads ?? [], threadFields],
    ["delivery", w.deliveries, deliveryFields],
    ["approval", w.approvals, approvalFields],
  ] as const)
    for (const value of values) {
      if (!value.browserSealed) continue;
      requireThat(
        value.browserRead,
        "browser_private_storage_unavailable",
        503,
      );
      unseal(
        record(value),
        fields,
        name(w, kind, value.id, value.browserRead.owner),
        key,
      );
    }
  return w;
}
