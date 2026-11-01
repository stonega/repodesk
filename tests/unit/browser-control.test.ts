import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type {
  BrowserHost,
  BrowserInvocation,
} from "../../src/browser/client.ts";
import type { BrowserOwner } from "../../src/browser/config.ts";
import {
  type BrowserAuthority,
  BrowserControl,
} from "../../src/browser/control.ts";
import type { BrowserRepository } from "../../src/browser/repository.ts";
import {
  type BrowserState,
  emptyBrowserState,
  profileKey,
} from "../../src/browser/state.ts";

class MemoryProfiles implements BrowserRepository {
  states = new Map<string, BrowserState>();
  async read(owner: BrowserOwner) {
    return structuredClone(
      this.states.get(profileKey(owner)) ?? emptyBrowserState(owner),
    );
  }
  async change<T>(owner: BrowserOwner, action: (state: BrowserState) => T) {
    const state = await this.read(owner);
    const result = action(state);
    this.states.set(profileKey(owner), structuredClone(state));
    return result;
  }
}
function fixture() {
  const repository = new MemoryProfiles();
  const calls: BrowserInvocation[] = [];
  const page = { id: randomUUID(), revision: 1, origin: "https://example.com" };
  const host: BrowserHost = {
    invoke: async (input) => {
      calls.push(input);
      return { status: "completed", page };
    },
  };
  const authority: BrowserAuthority = {
    owner: { workspaceId: randomUUID(), actor: "101" },
    controller: { kind: "chat", id: randomUUID(), fence: 1 },
    guard: async () => {},
  };
  return {
    repository,
    calls,
    page,
    host,
    authority,
    service: new BrowserControl(repository, host),
  };
}

describe("shared browser control service", () => {
  test("hands one user's existing profile to Codex while fencing the chat controller", async () => {
    const f = fixture();
    const chat = await f.service.acquire(f.authority);
    await f.service.perform(f.authority, chat.generation, "read", {
      action: "read",
    });
    const codex: BrowserAuthority = {
      ...f.authority,
      controller: { kind: "codex", id: randomUUID(), fence: 2 },
    };
    await expect(f.service.acquire(codex)).rejects.toThrow("browser_busy");
    await f.service.release(f.authority);
    const lease = await f.service.acquire(codex);
    await f.service.perform(codex, lease.generation, "codex-read", {
      action: "read",
    });
    await expect(
      f.service.perform(f.authority, chat.generation, "old-chat", {
        action: "read",
      }),
    ).rejects.toThrow("browser_control_expired");
    expect(new Set(f.calls.map((c) => profileKey(c.owner))).size).toBe(1);
  });
  test("a different actor or workspace cannot use the same controller and generation", async () => {
    const f = fixture();
    const lease = await f.service.acquire(f.authority);
    for (const owner of [
      { ...f.authority.owner, actor: "202" },
      { ...f.authority.owner, workspaceId: randomUUID() },
    ]) {
      await expect(
        f.service.perform(
          { ...f.authority, owner },
          lease.generation,
          randomUUID(),
          { action: "read" },
        ),
      ).rejects.toThrow("browser_control_expired");
    }
    expect(f.calls).toHaveLength(1);
  });
  test("authorizes again before releasing results if a grant is revoked during I/O", async () => {
    const f = fixture();
    const lease = await f.service.acquire(f.authority);
    let allowed = true;
    f.authority.guard = async () => {
      if (!allowed) throw new Error("access_denied");
    };
    f.host.invoke = async () => {
      allowed = false;
      return { status: "completed", text: "private page" };
    };
    await expect(
      f.service.perform(f.authority, lease.generation, "private-read", {
        action: "read",
      }),
    ).rejects.toThrow("access_denied");
    expect(
      (await f.repository.read(f.authority.owner)).operations[0]?.state,
    ).toBe("started");
  });
  test("host failure cannot cause a submission to repeat on reconstructed service", async () => {
    const f = fixture();
    const lease = await f.service.acquire(f.authority);
    let clicks = 0;
    f.host.invoke = async () => {
      clicks++;
      throw new Error("connection_lost");
    };
    const action = { action: "click", selector: "#submit" };
    await expect(
      f.service.perform(f.authority, lease.generation, "submit", action),
    ).rejects.toThrow("connection_lost");
    const reconstructed = new BrowserControl(f.repository, f.host);
    await expect(
      reconstructed.perform(f.authority, lease.generation, "submit", action),
    ).rejects.toThrow("browser_outcome_unknown");
    expect(clicks).toBe(1);
  });
  test("input is pinned to the actual page and is not retained or returned", async () => {
    const f = fixture();
    const lease = await f.service.acquire(f.authority);
    await f.service.perform(f.authority, lease.generation, "request", {
      action: "request_input",
      selector: "#password",
      label: "Website password",
      kind: "password",
    });
    const state = await f.repository.read(f.authority.owner);
    if (!state.input) throw new Error("missing input request");
    const submission = randomUUID();
    const password = "synthetic-input-never-in-state";
    expect(
      await f.service.submitInput(
        f.authority,
        state.input.id,
        submission,
        password,
      ),
    ).toEqual({ status: "completed" });
    const after = await f.repository.read(f.authority.owner);
    expect(after.input).toMatchObject({
      origin: f.page.origin,
      pageId: f.page.id,
      pageRevision: f.page.revision,
      state: "completed",
    });
    expect(JSON.stringify(after)).not.toContain(password);
    const call = f.calls.find((c) => c.operation.command === "input");
    expect(call?.operation).toMatchObject({
      command: "input",
      origin: f.page.origin,
      pageId: f.page.id,
      pageRevision: f.page.revision,
      value: password,
    });
    const before = f.calls.length;
    await f.service.submitInput(
      f.authority,
      state.input.id,
      submission,
      password,
    );
    expect(f.calls).toHaveLength(before);
  });
  test("takeover invalidates a password request before any fill reaches the host", async () => {
    const f = fixture();
    const lease = await f.service.acquire(f.authority);
    await f.service.perform(f.authority, lease.generation, "request", {
      action: "request_input",
      selector: "#code",
      label: "Code",
      kind: "code",
    });
    const state = await f.repository.read(f.authority.owner);
    if (!state.input) throw new Error("missing input request");
    await f.service.acquire(
      { ...f.authority, controller: BrowserControl.humanController() },
      true,
    );
    const before = f.calls.length;
    await expect(
      f.service.submitInput(
        f.authority,
        state.input.id,
        randomUUID(),
        "123456",
      ),
    ).rejects.toThrow("browser_control_expired");
    expect(f.calls).toHaveLength(before);
  });
  test("cancellation before dispatch prevents host invocation", async () => {
    const f = fixture();
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(
      f.service.acquire({ ...f.authority, signal: cancellation.signal }),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
});
