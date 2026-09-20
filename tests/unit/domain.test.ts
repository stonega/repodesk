import { describe, expect, test } from "bun:test";
import { validateSources } from "../../src/agent/context.ts";
import { requestDeletion, sweep } from "../../src/privacy/service.ts";
import {
  decrypt,
  encrypt,
  passwordHash,
  verifyPassword,
} from "../../src/setup/credentials.ts";
import { changeSkill, saveSkill } from "../../src/skills/catalog.ts";
import { importMarkdown } from "../../src/skills/import.ts";
import { command, updateSchema } from "../../src/telegram/router.ts";
import { nextOccurrences } from "../../src/workflows/schedule.ts";
import {
  decide,
  proposeInstruction,
  proposeWorkflow,
  tick,
  workflowAction,
} from "../../src/workflows/service.ts";
import {
  authorize,
  runAllowed,
  setPolicy,
} from "../../src/workspaces/policy.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { spec, workspace } from "../fixtures.ts";

describe("tenant and access boundaries", () => {
  test("whitelisting does not confer membership or admin role", () => {
    const w = workspace();
    w.policy.allowed.push("999");
    expect(() => authorize(w, "999")).toThrow("access_denied");
    expect(() => authorize(w, "202", true)).toThrow("access_denied");
    w.policy.allowed = [];
    expect(() => authorize(w, "101")).toThrow();
  });
  test("revocation invalidates queued work, approvals and schedules", () => {
    const w = workspace();
    const p = proposeWorkflow(w, "303", spec(w));
    decide(w, "303", p.approval.id, true);
    const r = createRun(w, "303", "hello", "-100100", 0, "gpt-4.1-mini");
    const a = proposeInstruction(w, "303", "short", "workspace", "test");
    setPolicy(w, "101", w.policy.version, "whitelist", ["101"]);
    expect(r.status).toBe("cancelled");
    expect(p.workflow.status).toBe("suspended");
    expect(a.decision).toBe("revoked");
    expect(runAllowed(w, r)).toBe(false);
  });
  test("last admin and stale writes are protected", () => {
    const w = workspace();
    expect(() =>
      setPolicy(w, "101", w.policy.version, "whitelist", ["202"]),
    ).toThrow("last_admin_lockout");
    expect(() => setPolicy(w, "101", 0, "members", [])).toThrow(
      "version_conflict",
    );
  });
  test("private sources and memory cannot enter group runs or other topics", () => {
    const w = workspace();
    const now = new Date().toISOString();
    w.messages = [
      {
        id: "private",
        chatId: "101",
        topicId: 0,
        author: "101",
        text: "secret",
        at: now,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        directed: true,
      },
      {
        id: "topic",
        chatId: "-100100",
        topicId: 9,
        author: "101",
        text: "topic secret",
        at: now,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        directed: true,
      },
    ];
    const a = proposeInstruction(
      w,
      "101",
      "personal secret",
      "personal",
      "test",
    );
    decide(w, "101", a.id, true);
    const r = createRun(w, "101", "recap", "-100100", 0, "gpt-4.1-mini");
    expect(r.sources).toHaveLength(0);
    expect(r.instructions).toHaveLength(0);
    expect(() =>
      createRun(w, "101", "hello", "202", 0, "gpt-4.1-mini"),
    ).toThrow("destination_denied");
  });
});
describe("approvals and scheduling", () => {
  test("exact actor, version, payload, expiry and replay enforced", () => {
    const w = workspace();
    const p = proposeWorkflow(w, "101", spec(w));
    expect(() => decide(w, "303", p.approval.id, true)).toThrow(
      "approval_denied",
    );
    p.workflow.spec.format = "changed";
    expect(() => decide(w, "101", p.approval.id, true)).toThrow(
      "approval_changed",
    );
    p.workflow.spec.format = spec(w).format;
    decide(w, "101", p.approval.id, true);
    expect(() => decide(w, "101", p.approval.id, true)).toThrow(
      "approval_consumed",
    );
    const expired = proposeInstruction(w, "101", "text", "workspace", "test");
    expect(() =>
      decide(w, "101", expired.id, true, new Date(Date.now() + 1000000)),
    ).toThrow("approval_expired");
  });
  test("occurrence is unique and pause cancels dependent work", () => {
    const w = workspace();
    const now = new Date("2026-09-18T08:59:00Z");
    const p = proposeWorkflow(w, "101", spec(w), now);
    decide(w, "101", p.approval.id, true, now);
    tick(w, "gpt-4.1-mini", new Date("2026-09-18T09:00:00Z"));
    tick(w, "gpt-4.1-mini", new Date("2026-09-18T09:00:00Z"));
    expect(w.runs).toHaveLength(1);
    expect(w.occurrences).toHaveLength(1);
    workflowAction(w, "101", p.workflow.id, "pause", 1, "gpt-4.1-mini");
    expect(w.runs[0]?.status).toBe("cancelled");
  });
  test("late occurrences skip without backfill and notify owner", () => {
    const w = workspace();
    const now = new Date("2026-09-18T08:59:00Z");
    const p = proposeWorkflow(w, "101", spec(w), now);
    decide(w, "101", p.approval.id, true, now);
    tick(w, "gpt-4.1-mini", new Date("2026-09-18T10:00:00Z"));
    expect(w.runs).toHaveLength(0);
    expect(w.occurrences[0]?.status).toBe("skipped");
    expect(w.deliveries[0]?.chatId).toBe("101");
  });
  test("DST gaps skipped; repeated local times execute once at earlier instant", () => {
    expect(
      nextOccurrences(
        {
          frequency: "daily",
          hour: 2,
          minute: 30,
          timezone: "America/New_York",
        },
        new Date("2026-03-08T00:00:00Z"),
        1,
      ),
    ).toEqual(["2026-03-09T06:30:00Z"]);
    const rule = {
      frequency: "daily" as const,
      hour: 1,
      minute: 30,
      timezone: "America/New_York",
    };
    expect(nextOccurrences(rule, new Date("2026-11-01T00:00:00Z"), 2)).toEqual([
      "2026-11-01T05:30:00Z",
      "2026-11-02T06:30:00Z",
    ]);
    expect(nextOccurrences(rule, new Date("2026-11-01T05:31:00Z"), 1)).toEqual([
      "2026-11-02T06:30:00Z",
    ]);
  });
});
describe("skills, memory, retention", () => {
  test("approved correction affects only future snapshots; forget removes future context", () => {
    const w = workspace();
    const a = proposeInstruction(w, "101", "Use bullets", "workspace", "test");
    const old = createRun(w, "101", "hello", "-100100", 0, "gpt-4.1-mini");
    decide(w, "101", a.id, true);
    const next = createRun(w, "303", "hello", "-100100", 0, "gpt-4.1-mini");
    expect(old.instructions).toHaveLength(0);
    expect(next.instructions[0]?.body).toBe("Use bullets");
    const instruction = w.instructions[0];
    if (instruction) instruction.active = false;
    expect(
      createRun(w, "101", "again", "-100100", 0, "gpt-4.1-mini").instructions,
    ).toHaveLength(0);
  });
  test("skill disable stops pinned runs; importing metadata never grants shell", () => {
    const w = workspace();
    const run = createRun(w, "101", "hi", "-100100", 0, "gpt-4.1-mini");
    const skill = w.skills[0];
    if (!skill) throw Error();
    changeSkill(w, "101", skill.id, skill.version, "disable");
    expect(run.status).toBe("cancelled");
    expect(() =>
      importMarkdown(
        "---\nname: bad-skill\ndescription: malicious\nallowed-tools: shell\n---\nRun shell commands",
      ),
    ).toThrow();
    expect(() =>
      importMarkdown("---\nname: bad-skill\nscript: install.sh\n---\nhi"),
    ).toThrow("unsupported_frontmatter");
    expect(() => saveSkill(w, "101", skill.draft)).toThrow("duplicate_slug");
  });
  test("unknown source citations fail", () => {
    const w = workspace();
    const run = createRun(w, "101", "hello", "-100100", 0, "gpt-4.1-mini");
    expect(() => validateSources("Claim [source:other-tenant]", run)).toThrow(
      "invalid_source_citation",
    );
  });
  test("deletion tombstone prevents runs and purges content", () => {
    const w = workspace();
    w.plugins = { revision: 1, entries: [] };
    w.github = {
      revision: 1,
      installationId: 501,
      repositories: [{ id: 7001, full_name: "example/private" }],
    };
    createRun(w, "101", "hello", "-100100", 0, "gpt-4.1-mini");
    const p = requestDeletion(w, "101");
    decide(w, "101", p.id, true);
    expect(() => authorize(w, "101")).toThrow();
    sweep(w);
    expect(w.runs).toHaveLength(0);
    expect(w.skills).toHaveLength(0);
    expect(w.plugins).toBeUndefined();
    expect(w.github).toBeUndefined();
    expect(w.deletion?.purgedAt).toBeDefined();
  });
});
describe("transport and credentials", () => {
  test("command entities and addressed bot names are respected", () => {
    const m = updateSchema.parse({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: -100100, type: "supergroup" },
        from: { id: 101, is_bot: false },
        text: "/ask@another_bot hi",
        entities: [{ type: "bot_command", offset: 0, length: 16 }],
      },
    }).message;
    if (!m) throw Error();
    expect(command(m, { id: "999", username: "ours" })).toBeUndefined();
    m.text = "/ask@ours hi";
    m.entities = [{ type: "bot_command", offset: 0, length: 9 }];
    expect(command(m, { id: "999", username: "ours" })).toEqual({
      name: "ask",
      args: "hi",
    });
    m.sender_chat = m.chat;
    expect(command(m, { id: "999", username: "ours" })).toBeUndefined();
  });
  test("encrypted credentials are authenticated and name-bound", () => {
    const key = "ab".repeat(32);
    const ciphertext = encrypt(key, "bot", "secret-value");
    expect(ciphertext).not.toContain("secret-value");
    expect(decrypt(key, "bot", ciphertext)).toBe("secret-value");
    expect(() => decrypt(key, "model", ciphertext)).toThrow();
  });
  test("passwords use salted hashes", async () => {
    const a = await passwordHash("long test password");
    const b = await passwordHash("long test password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("long test password", a)).toBe(true);
    expect(await verifyPassword("bad", a)).toBe(false);
  });
});

test("retention removes content without releasing this month's settled usage", () => {
  const w = workspace();
  w.settings.retentionDays = 1;
  const now = new Date();
  const run = createRun(
    w,
    "101",
    "old private text",
    "101",
    0,
    "gpt-4.1-mini",
    { now: new Date(now.getTime() - 2 * 86400000) },
  );
  run.attempts.push({
    id: "billed",
    at: run.at,
    reserved: 0.05,
    actual: 0.02,
    status: "settled",
  });
  sweep(w, now);
  expect(w.runs).toHaveLength(1);
  expect(w.runs[0]?.task).toBe("[expired]");
  expect(w.runs[0]?.attempts[0]?.actual).toBe(0.02);
});

test("eligible teammates can run a shared group workflow without gaining administration", () => {
  const w = workspace();
  const p = proposeWorkflow(w, "101", spec(w));
  decide(w, "101", p.approval.id, true);
  const r = workflowAction(w, "202", p.workflow.id, "run", 1, "gpt-4.1-mini");
  expect("actor" in r && r.actor).toBe("202");
  const run = w.runs[0];
  if (!run) throw Error();
  expect(runAllowed(w, run)).toBe(true);
  expect(() =>
    workflowAction(w, "202", p.workflow.id, "pause", 1, "gpt-4.1-mini"),
  ).toThrow("access_denied");
  const owned = proposeWorkflow(w, "202", spec(w));
  decide(w, "202", owned.approval.id, true);
  const correction = proposeInstruction(
    w,
    "202",
    "My workflow format",
    "workflow",
    "test",
    owned.workflow.id,
  );
  decide(w, "202", correction.id, true);
  expect(w.instructions.at(-1)?.author).toBe("202");
});
