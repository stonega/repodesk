import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { Fault, type Run, type Workspace } from "../../src/domain.ts";
import { WebReader } from "../../src/web-reader/service.ts";
import { webReaderTool } from "../../src/web-reader/tool.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

const rootUrl = process.env.TEST_DATABASE_URL;
(rootUrl ? describe : describe.skip)("built-in web reader", () => {
  const root = database(rootUrl ?? "postgres://unused@localhost/unused");
  const name = `web_reader_${randomUUID().replaceAll("-", "")}`;
  let store: Store, w: Workspace, run: Run, calls: number;
  let duringRead: (() => Promise<void>) | undefined;
  let failure: boolean;
  const reader = new WebReader();
  reader.read = async (url, signal) => {
    calls++;
    await duringRead?.();
    signal?.throwIfAborted();
    if (failure) throw new Fault("web_read_http_failed");
    return {
      url,
      title: "Fixture",
      description: "",
      author: "",
      published: "",
      markdown: "Public article",
      truncated: false,
    };
  };
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const url = new URL(rootUrl ?? "");
    url.pathname = `/${name}`;
    store = new Store(database(url.toString()));
    await migrate(store.pool);
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });
  beforeEach(async () => {
    calls = 0;
    failure = false;
    duringRead = undefined;
    w = workspace();
    await store.pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,$2,'unused',true)",
      [w.operatorId, `reader-${w.operatorId}`],
    );
    run = createRun(
      w,
      "202",
      "Read https://example.com/article",
      "202",
      0,
      "gpt-4.1-mini",
    );
    run.status = "running";
    run.fence = 1;
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, w.operatorId, JSON.stringify(w)],
    );
  });
  const tool = (workspaceId = w.id, fence = 1, guard = async () => {}) =>
    webReaderTool(store, workspaceId, run.id, fence, guard, reader);
  const args = { url: "https://example.com/article" };

  test("available to active members with no search configuration or skill grant; durable duplicate calls read once", async () => {
    expect(w.chatModel?.searchProviderId).toBeUndefined();
    run.skillPins = [];
    const first = await tool().execute("read", args);
    expect(JSON.stringify(first)).toContain("Public article");
    expect(await tool().execute("read", { url: `${args.url}#part` })).toEqual(
      first,
    );
    expect(calls).toBe(1);
    await expect(
      tool().execute("read", { url: "https://example.com/different" }),
    ).rejects.toThrow("tool_call_conflict");
    expect(calls).toBe(1);
  });

  test("unknown reads never replay; arguments cannot supply a tenant, actor or credentials", async () => {
    await store.change(w.id, (current) => {
      const r = current.runs.find((r) => r.id === run.id);
      if (r)
        r.tools.unknown = {
          name: "read_web",
          state: "started",
          arguments: args,
        };
    });
    await expect(tool().execute("unknown", args)).rejects.toThrow(
      "web_read_outcome_unknown",
    );
    for (const input of [
      { ...args, workspaceId: randomUUID() },
      { ...args, actor: "101" },
      { url: "http://user:secret@example.com" },
      { url: "file:///etc/passwd" },
    ])
      await expect(tool().execute("invalid", input)).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test("concurrent duplicate reads reserve a single external request", async () => {
    let started!: () => void, finish!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const released = new Promise<void>((resolve) => {
      finish = resolve;
    });
    duringRead = async () => {
      started();
      await released;
    };
    const first = tool().execute("concurrent", args);
    await began;
    try {
      await expect(tool().execute("concurrent", args)).rejects.toThrow(
        "web_read_outcome_unknown",
      );
      expect(calls).toBe(1);
    } finally {
      finish();
    }
    await first;
  });

  test("removing a group destination revokes a previously completed read", async () => {
    await store.change(w.id, (current) => {
      const r = current.runs.find((r) => r.id === run.id);
      if (r) r.chatId = "-100100";
    });
    await tool().execute("group", args);
    await store.change(w.id, (current) => {
      const chat = current.chats.find((c) => c.id === "-100100");
      if (chat) chat.active = false;
    });
    await expect(tool().execute("group", args)).rejects.toThrow(
      "tool_policy_denied",
    );
    expect(calls).toBe(1);
  });

  test("workspace/run identity, fencing, current membership and pause guard cached results", async () => {
    await tool().execute("cached", args);
    const foreign = workspace();
    foreign.operatorId = w.operatorId;
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [foreign.id, foreign.operatorId, JSON.stringify(foreign)],
    );
    await expect(tool(foreign.id).execute("cached", args)).rejects.toThrow(
      "tool_policy_denied",
    );
    await expect(tool(w.id, 2).execute("cached", args)).rejects.toThrow(
      "tool_policy_denied",
    );
    await store.change(w.id, (current) => {
      current.settings.paused = true;
    });
    await expect(tool().execute("cached", args)).rejects.toThrow(
      "tool_policy_denied",
    );
    await store.change(w.id, (current) => {
      current.settings.paused = false;
      const member = current.members.find((m) => m.id === run.actor);
      if (member) member.active = false;
    });
    await expect(tool().execute("cached", args)).rejects.toThrow(
      "tool_policy_denied",
    );
    expect(calls).toBe(1);
  });

  test("revocation during a read discards data and leaves the call uncertain", async () => {
    duringRead = () =>
      store.change(w.id, (current) => {
        current.settings.paused = true;
      });
    await expect(tool().execute("revoked", args)).rejects.toThrow(
      "tool_policy_denied",
    );
    const saved = (await store.read(w.id)).runs.find((r) => r.id === run.id)
      ?.tools.revoked;
    expect(saved?.state).toBe("started");
    expect(saved?.result).toBeUndefined();
  });

  test("deployment guards and cancellation are checked before network and cached reuse", async () => {
    await tool().execute("cached", args);
    await expect(
      tool(w.id, 1, async () => {
        throw new Fault("deployment_paused");
      }).execute("cached", args),
    ).rejects.toThrow("deployment_paused");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      tool().execute("new", args, controller.signal),
    ).rejects.toThrow("cancelled");
    expect(calls).toBe(1);
  });

  test("read errors are bounded tool results and are replayed without a request", async () => {
    failure = true;
    const result = await tool().execute("error", args);
    expect(result.content).toEqual([
      { type: "text", text: '{"error":"web_read_http_failed"}' },
    ]);
    expect(await tool().execute("error", args)).toEqual(result);
    expect(calls).toBe(1);
  });
});
