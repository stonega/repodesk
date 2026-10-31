import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { browserAction, browserEnabled } from "../../src/browser/config.ts";
import {
  authorizeBrowserOwner,
  authorizeBrowserRun,
} from "../../src/browser/policy.ts";
import {
  signBrowserRequest,
  verifyBrowserRequest,
} from "../../src/browser/protocol.ts";
import {
  acquireBrowser,
  emptyBrowserState,
  profileKey,
  releaseBrowser,
  requestBrowserInput,
  requireBrowserLease,
  reserveBrowserInput,
  reserveBrowserOperation,
} from "../../src/browser/state.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

const owner = () => ({ workspaceId: randomUUID(), actor: "101" });
const controller = () => ({
  kind: "chat" as const,
  id: randomUUID(),
  fence: 1,
});
const input = {
  origin: "https://example.com",
  pageId: "page-1",
  pageRevision: 2,
  selector: "#password",
  label: "Account password",
  kind: "password" as const,
};

describe("private shared Browser coordination", () => {
  test("defaults on, preserves explicit disablement and permits ordinary members", () => {
    const w = workspace();
    expect(browserEnabled(w)).toBe(true);
    expect(() => authorizeBrowserOwner(w, "202")).not.toThrow();
    w.plugins = {
      revision: 1,
      entries: [],
      browser: { enabled: false, generation: 1 },
    };
    expect(browserEnabled(w)).toBe(false);
    expect(() => authorizeBrowserOwner(w, "202")).toThrow("browser_disabled");
    expect(() => authorizeBrowserOwner(w, "202", true)).not.toThrow();
  });
  test("stable owner includes tenant and verified user, not the consuming plugin", () => {
    const a = owner();
    expect(profileKey(a)).toBe(profileKey({ ...a }));
    expect(profileKey(a)).not.toBe(profileKey({ ...a, actor: "202" }));
    expect(profileKey(a)).not.toBe(
      profileKey({ ...a, workspaceId: randomUUID() }),
    );
    expect(() => profileKey({ ...a, actor: "name" })).toThrow();
  });
  test("another consumer cannot race a live controller", () => {
    const state = emptyBrowserState(owner());
    const chat = controller();
    const lease = acquireBrowser(state, chat, 100);
    expect(() =>
      acquireBrowser(state, { ...controller(), kind: "codex" }, 101),
    ).toThrow("browser_busy");
    expect(() =>
      requireBrowserLease(state, chat, lease.generation, 102),
    ).not.toThrow();
  });
  test("same controller renewal preserves its generation", () => {
    const state = emptyBrowserState(owner());
    const chat = controller();
    const first = acquireBrowser(state, chat, 100);
    expect(acquireBrowser(state, chat, 101).generation).toBe(first.generation);
    expect(state.lease?.expiresAt).toBeGreaterThan(first.expiresAt);
  });
  test("a verified new attempt of the same task fences its previous attempt", () => {
    const state = emptyBrowserState(owner()),
      chat = controller();
    const first = acquireBrowser(state, chat, 100);
    const next = acquireBrowser(state, { ...chat, fence: 2 }, 101);
    expect(next.generation).toBeGreaterThan(first.generation);
    expect(() =>
      requireBrowserLease(state, chat, first.generation, 102),
    ).toThrow("browser_control_expired");
    expect(() => acquireBrowser(state, chat, 103)).toThrow("browser_busy");
  });
  test("authorized handoff and human takeover fence old commands and input", () => {
    const state = emptyBrowserState(owner());
    const chat = controller();
    const lease = acquireBrowser(state, chat, 100);
    requestBrowserInput(state, chat, lease.generation, input, 101);
    const human = { ...controller(), kind: "human" as const };
    const next = acquireBrowser(state, human, 102, true);
    expect(next.generation).toBeGreaterThan(lease.generation);
    expect(state.input?.state).toBe("cancelled");
    expect(() =>
      requireBrowserLease(state, chat, lease.generation, 103),
    ).toThrow("browser_control_expired");
  });
  test("expired leases cannot authorize old executors even after reacquisition", () => {
    const state = emptyBrowserState(owner());
    const chat = controller();
    const first = acquireBrowser(state, chat, 100);
    const next = acquireBrowser(state, chat, first.expiresAt);
    expect(() =>
      requireBrowserLease(state, chat, first.generation, first.expiresAt),
    ).toThrow();
    expect(next.generation).toBeGreaterThan(first.generation);
  });
  test("renewing a controller does not shorten the user's pending input window", () => {
    const state = emptyBrowserState(owner());
    const chat = controller();
    const lease = acquireBrowser(state, chat, 100);
    const request = requestBrowserInput(
      state,
      chat,
      lease.generation,
      input,
      101,
    );
    expect(acquireBrowser(state, chat, 102).expiresAt).toBe(request.expiresAt);
  });
  test("a plugin cannot force takeover by setting a boolean flag", () => {
    const state = emptyBrowserState(owner());
    acquireBrowser(state, controller(), 100);
    expect(() =>
      acquireBrowser(
        state,
        { kind: "codex", id: randomUUID(), fence: 1 },
        101,
        true,
      ),
    ).toThrow("browser_takeover_denied");
  });
  test("uncertain external actions never replay after process reconstruction", () => {
    const state = emptyBrowserState(owner());
    const chat = controller();
    const lease = acquireBrowser(state, chat, 100);
    reserveBrowserOperation(
      state,
      chat,
      lease.generation,
      "call-1",
      { action: "click", selector: "#submit" },
      101,
    );
    const restored = JSON.parse(JSON.stringify(state));
    expect(() =>
      reserveBrowserOperation(
        restored,
        chat,
        lease.generation,
        "call-1",
        { action: "click", selector: "#submit" },
        102,
      ),
    ).toThrow("browser_outcome_unknown");
    expect(() =>
      reserveBrowserOperation(
        restored,
        chat,
        lease.generation,
        "call-1",
        { action: "click", selector: "#other" },
        102,
      ),
    ).toThrow("browser_duplicate_conflict");
  });
  test("completed operation receipt is idempotent without re-execution", () => {
    const state = emptyBrowserState(owner());
    const chat = controller();
    const lease = acquireBrowser(state, chat, 100);
    reserveBrowserOperation(
      state,
      chat,
      lease.generation,
      "call-1",
      { action: "read" },
      101,
    );
    const op = state.operations[0];
    if (!op) throw new Error("missing fixture operation");
    op.state = "completed";
    op.result = { status: "completed", reference: randomUUID() };
    expect(
      reserveBrowserOperation(
        state,
        chat,
        lease.generation,
        "call-1",
        { action: "read" },
        102,
      )?.result,
    ).toEqual(op.result);
    expect(state.operations).toHaveLength(1);
  });
  test("waiting input pins origin/page/revision and pauses unrelated actions", () => {
    const state = emptyBrowserState(owner());
    const chat = controller();
    const lease = acquireBrowser(state, chat, 100);
    const request = requestBrowserInput(
      state,
      chat,
      lease.generation,
      input,
      101,
    );
    expect(request).toMatchObject(input);
    expect(() =>
      reserveBrowserOperation(
        state,
        chat,
        lease.generation,
        "call-2",
        { action: "navigate", url: "https://other.example" },
        102,
      ),
    ).toThrow("browser_input_pending");
    expect(JSON.stringify(state)).not.toContain('"value"');
  });
  test("input duplicates cannot repeat a fill with an uncertain outcome", () => {
    const state = emptyBrowserState(owner());
    const chat = controller();
    const lease = acquireBrowser(state, chat, 100);
    const request = requestBrowserInput(
      state,
      chat,
      lease.generation,
      input,
      101,
    );
    const submission = randomUUID();
    expect(
      reserveBrowserInput(state, request.id, submission, 102).completed,
    ).toBe(false);
    expect(() =>
      reserveBrowserInput(state, request.id, submission, 103),
    ).toThrow("browser_outcome_unknown");
    expect(() =>
      reserveBrowserInput(state, request.id, randomUUID(), 103),
    ).toThrow("browser_duplicate_conflict");
    if (!state.input) throw new Error("missing fixture input");
    state.input.state = "completed";
    expect(
      reserveBrowserInput(state, request.id, submission, 104).completed,
    ).toBe(true);
  });
  test("cancelled and expired input cannot be submitted", () => {
    const state = emptyBrowserState(owner());
    const chat = controller();
    const lease = acquireBrowser(state, chat, 100);
    const request = requestBrowserInput(
      state,
      chat,
      lease.generation,
      input,
      101,
    );
    expect(() =>
      reserveBrowserInput(state, request.id, randomUUID(), request.expiresAt),
    ).toThrow("browser_input_expired");
    releaseBrowser(state, 102);
    expect(() =>
      reserveBrowserInput(state, request.id, randomUUID(), 103),
    ).toThrow("browser_control_expired");
  });
  test("takeover during a submitted input retains an unknown outcome", () => {
    const state = emptyBrowserState(owner());
    const chat = controller();
    const lease = acquireBrowser(state, chat, 100);
    const request = requestBrowserInput(
      state,
      chat,
      lease.generation,
      input,
      101,
    );
    reserveBrowserInput(state, request.id, randomUUID(), 102);
    acquireBrowser(state, { ...controller(), kind: "human" }, 103, true);
    expect(state.input?.state).toBe("unknown");
  });
  test("browser actions cannot inject actor, paths or arbitrary evaluation", () => {
    for (const key of ["Control+L", "Control+O", "F12", "/etc/passwd"])
      expect(browserAction.safeParse({ action: "press", key }).success).toBe(
        false,
      );
    expect(
      browserAction.safeParse({ action: "press", key: "Enter" }).success,
    ).toBe(true);
    expect(
      browserAction.safeParse({ action: "read", actor: "202" }).success,
    ).toBe(false);
    expect(
      browserAction.safeParse({ action: "evaluate", script: "document.cookie" })
        .success,
    ).toBe(false);
    expect(
      browserAction.safeParse({
        action: "fill",
        selector: "#name",
        text: "hello",
      }).success,
    ).toBe(true);
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://name:secret@example.com/",
    ]) {
      expect(browserAction.safeParse({ action: "navigate", url }).success).toBe(
        false,
      );
    }
  });
  test("inactive users, unbound actors and unlinked operator IDs are denied", () => {
    const w = workspace();
    for (const actor of ["404", w.operatorId])
      expect(() => authorizeBrowserOwner(w, actor)).toThrow("access_denied");
    const member = w.members.find((m) => m.id === "202");
    if (member) member.active = false;
    expect(() => authorizeBrowserOwner(w, "202", true)).toThrow(
      "access_denied",
    );
  });
  test("run binding rejects actor substitution, stale fences, groups and schedules", () => {
    const w = workspace();
    const run = createRun(w, "101", "Browse", "101", 0, "gpt-4.1-mini");
    run.status = "running";
    run.fence = 1;
    expect(authorizeBrowserRun(w, run.id, "101", 1, 0)).toBe(run);
    expect(() => authorizeBrowserRun(w, run.id, "202", 1, 0)).toThrow();
    expect(() => authorizeBrowserRun(w, run.id, "101", 0, 0)).toThrow();
    run.chatId = "-100100";
    expect(() => authorizeBrowserRun(w, run.id, "101", 1, 0)).toThrow(
      "browser_private_task_required",
    );
    run.chatId = "101";
    run.workflowId = randomUUID();
    expect(() => authorizeBrowserRun(w, run.id, "101", 1, 0)).toThrow();
  });
});

describe("authenticated host browser protocol", () => {
  const key = "synthetic-browser-service-key-32-characters";
  const fixture = () => ({
    owner: owner(),
    controller: controller(),
    generation: 1,
    operation: { command: "status" as const },
  });
  test("binds full owner, consumer and operation without transmitting management key", () => {
    const signed = signBrowserRequest(key, fixture(), 1000);
    expect(
      verifyBrowserRequest(key, signed.body, signed.signature, 1001).generation,
    ).toBe(1);
    expect(signed.body).not.toContain(key);
    const modified = JSON.parse(signed.body);
    modified.owner.actor = "202";
    expect(() =>
      verifyBrowserRequest(
        key,
        JSON.stringify(modified),
        signed.signature,
        1001,
      ),
    ).toThrow("browser_unauthorized");
  });
  test("rejects expired, future, wrong-key and oversized requests", () => {
    const signed = signBrowserRequest(key, fixture(), 1000);
    expect(() =>
      verifyBrowserRequest(key, signed.body, signed.signature, 31_000),
    ).toThrow("browser_request_expired");
    expect(() =>
      verifyBrowserRequest(key, signed.body, signed.signature, -5000),
    ).toThrow("browser_request_expired");
    expect(() =>
      verifyBrowserRequest(`${key}-wrong`, signed.body, signed.signature, 1001),
    ).toThrow("browser_unauthorized");
    expect(() =>
      verifyBrowserRequest(key, "x".repeat(32769), signed.signature, 1001),
    ).toThrow("browser_unauthorized");
  });
});
