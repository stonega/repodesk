import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { runSummaries } from "../../src/admin/run-history.ts";
import {
  threadDetail,
  threadSummaries,
} from "../../src/admin/thread-history.ts";
import { workHandoff } from "../../src/agent/work-handoff.ts";
import {
  browserPanelRun,
  browserPrivateGrants,
  browserReadAllowed,
  browserRunPrivate,
} from "../../src/browser/privacy.ts";
import {
  decodeBrowserWorkspace,
  encodeBrowserWorkspace,
} from "../../src/browser/storage.ts";
import { memoryScope, scopeSources } from "../../src/memory/state.ts";
import { fingerprint } from "../../src/setup/credentials.ts";
import { createRun } from "../../src/workspaces/service.ts";
import {
  recordThreadAnswer,
  retainedSource,
} from "../../src/workspaces/threads.ts";
import { workspace } from "../fixtures.ts";

const key = "ab".repeat(32);
function fixture() {
  const w = workspace(),
    r = createRun(
      w,
      "202",
      "private-browser-request",
      "202",
      0,
      "gpt-4.1-mini",
      { botId: "9" },
    );
  r.browserRead = { owner: "202", generation: 0, epoch: 0, botId: "9" };
  r.status = "succeeded";
  r.result = "private-browser-result";
  r.transcript = [{ private: "private-browser-transcript" }];
  r.tools = {
    private: {
      name: "browser_action",
      state: "done",
      result: { text: "private-browser-tool" },
    },
  };
  recordThreadAnswer(w, r);
  return { w, r };
}
test("browser evidence stays private across derived sources, retention and actor substitution", () => {
  const { w, r } = fixture();
  expect(browserReadAllowed(w, r, "9")).toBe(true);
  for (const other of [
    { ...r, actor: "101", chatId: "101" },
    { ...r, chatId: "-100" },
    { ...r, workflowId: randomUUID() },
  ])
    expect(browserReadAllowed(w, other, "9")).toBe(false);
  const derived = structuredClone(r);
  derived.id = randomUUID();
  delete derived.browserRead;
  derived.sources = w.messages.filter(
    (source) => source.runId === r.id && source.role === "assistant",
  );
  expect(browserRunPrivate(w, derived)).toBe(true);
  w.runs = [derived];
  expect(browserPrivateGrants(w, derived).length).toBeGreaterThan(0);
  w.browserEpochs = { "202": 1 };
  expect(browserReadAllowed(w, derived, "9")).toBe(false);
  expect(derived.sources.every((source) => !retainedSource(w, source))).toBe(
    true,
  );
});
test("panel run/thread histories redact private browser content including derived runs", () => {
  const { w, r } = fixture();
  expect(JSON.stringify(browserPanelRun(w, r))).not.toContain(
    "private-browser-",
  );
  expect(JSON.stringify(runSummaries(w, 0, 25))).not.toContain(
    "private-browser-",
  );
  expect(JSON.stringify(threadSummaries(w, 0, 25))).not.toContain(
    "private-browser-",
  );
  if (r.threadId)
    expect(JSON.stringify(threadDetail(w, r.threadId, 0, 25))).not.toContain(
      "private-browser-",
    );
});
test("private run bodies, messages, topic memory and deliveries are encrypted while queue metadata remains queryable", () => {
  const { w, r } = fixture();
  const thread = w.threads?.find((thread) => thread.id === r.threadId);
  if (thread)
    thread.discussions = [
      {
        id: randomUUID(),
        title: "private-browser-discussion",
        summary: "private-browser-summary",
        decisions: [],
        todos: [],
        relatedIds: [],
        messageIds: [],
        updatedAt: new Date().toISOString(),
        sourceIds: [],
        sourceHash: "fixture",
      },
    ];
  w.deliveries.push({
    id: randomUUID(),
    actor: r.actor,
    chatId: r.chatId,
    topicId: 0,
    runId: r.id,
    text: "private-browser-delivery",
    state: "pending",
    at: r.at,
    attempts: 0,
  });
  const encoded = encodeBrowserWorkspace(w, key);
  expect(JSON.stringify(encoded)).not.toContain("private-browser-");
  expect(encoded.runs.find((run) => run.id === r.id)?.status).toBe("succeeded");
  expect(encoded.runs.find((run) => run.id === r.id)?.actor).toBe("202");
  expect(
    decodeBrowserWorkspace(structuredClone(encoded), key).runs.find(
      (run) => run.id === r.id,
    )?.result,
  ).toBe(r.result);
  expect(w.runs.find((run) => run.id === r.id)?.result).toBe(r.result);
  expect(() => decodeBrowserWorkspace(structuredClone(encoded))).toThrow(
    "browser_private_storage_unavailable",
  );
});
test("ciphertexts cannot be swapped between tenants or owners", () => {
  const { w, r } = fixture();
  const encoded = encodeBrowserWorkspace(w, key);
  encoded.id = randomUUID();
  expect(() => decodeBrowserWorkspace(encoded, key)).toThrow(
    "browser_private_storage_unavailable",
  );
  const swapped = encodeBrowserWorkspace(w, key),
    run = swapped.runs.find((run) => run.id === r.id);
  if (!run?.browserRead) throw Error("missing fixture");
  run.browserRead.owner = "101";
  expect(() => decodeBrowserWorkspace(swapped, key)).toThrow(
    "browser_private_storage_unavailable",
  );
});
test("private browser outputs do not enter automatic long-term memory extraction", () => {
  const { w, r } = fixture();
  const scope = memoryScope(w, r);
  if (!scope) throw Error("missing private scope fixture");
  expect(scopeSources(w, scope).some((source) => source.browserRead)).toBe(
    false,
  );
});
test("private browser approvals remain encrypted after the originating run expires", () => {
  const { w, r } = fixture();
  const payload = { body: "private-browser-approval" };
  w.approvals.push({
    id: randomUUID(),
    actor: r.actor,
    runId: r.id,
    kind: "github_issue",
    target: randomUUID(),
    version: 1,
    hash: fingerprint(payload),
    payload,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  const encoded = encodeBrowserWorkspace(w, key);
  expect(JSON.stringify(encoded)).not.toContain("private-browser-approval");
  const decoded = decodeBrowserWorkspace(encoded, key);
  expect(decoded.approvals[0]?.payload).toEqual(payload);
  decoded.runs = [];
  decoded.messages = [];
  decoded.deliveries = [];
  decoded.threads = [];
  expect(JSON.stringify(encodeBrowserWorkspace(decoded, key))).not.toContain(
    "private-browser-approval",
  );
});
test("work handoff retains personal browser authorization on the consuming run", () => {
  const { w, r } = fixture();
  const next = createRun(
    w,
    "202",
    "Continue my work",
    "202",
    1,
    "gpt-4.1-mini",
    { botId: "9" },
  );
  const result = workHandoff(w, next, [], { query: "private-browser-request" });
  expect(result.entries.some((entry) => entry.id === `run:${r.id}`)).toBe(true);
  expect(next.browserRead).toEqual(r.browserRead);
  const other = createRun(w, "101", "Read work", "101", 2, "gpt-4.1-mini", {
    botId: "9",
  });
  expect(
    workHandoff(w, other, [], { query: "private-browser-request" }).entries,
  ).toHaveLength(0);
  w.browserEpochs = { "202": 1 };
  expect(browserReadAllowed(w, next, "9")).toBe(false);
});
