import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { buildContext } from "../../src/agent/context.ts";
import { applicationTools } from "../../src/agent/tools.ts";
import {
  decodeBrowserWorkspace,
  encodeBrowserWorkspace,
} from "../../src/browser/storage.ts";
import type { Store } from "../../src/db/repositories.ts";
import type { Run, Workflow, Workspace } from "../../src/domain.ts";
import { sweep } from "../../src/privacy/service.ts";
import { changeSkill } from "../../src/skills/catalog.ts";
import { ensureTelegramWidgetSkill } from "../../src/skills/telegram-widgets.ts";
import {
  authorizeWidget,
  publishWidget,
  stageWidget,
  telegramWidgetAvailable,
  widgetDeliveryAllowed,
} from "../../src/telegram/widgets.ts";
import { tick } from "../../src/workflows/service.ts";
import { memoryReferences } from "../../src/workspaces/conversation-memory.ts";
import { createRun } from "../../src/workspaces/service.ts";
import {
  originalTelegramWidgetSpec,
  proactiveTelegramWidgetSpec,
} from "../fixtures/telegram-widgets.ts";
import { spec, workspace } from "../fixtures.ts";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error("Missing fixture");
  return value;
}
const args = {
  html: "<h3>Estimate</h3><button onclick=\"this.textContent='2'\">1</button>",
  caption: "Local estimate: 1 seat. Preview only.",
};
function fixture(chatId = "101") {
  const w = workspace();
  const r = createRun(
    w,
    "101",
    "Make an interactive estimate",
    chatId,
    7,
    "gpt-4.1-mini",
    { botId: "999", replyTo: 42 },
  );
  r.status = "running";
  r.fence = 1;
  return { w, r };
}
function scheduledFixture(topicId = 7, chatId = "101") {
  const w = workspace();
  const f: Workflow = {
    id: randomUUID(),
    owner: "101",
    version: 1,
    status: "active" as const,
    spec: {
      ...spec(w),
      chatId,
      topicId,
      skillId: undefined,
      task: "Report current weather as a compact widget",
    },
    versions: [],
    nextAt: new Date().toISOString(),
  };
  w.workflows.push(f);
  tick(w, "gpt-4.1-mini");
  const r = required(w.runs.at(-1));
  r.status = "running";
  r.fence = 1;
  return { w, r, f };
}
function tool(
  w: Workspace,
  r: Run,
  deployment = { active: true, paused: false, bot: { id: "999" } },
  workspaceId = w.id,
  fence = r.fence,
  name = "send_telegram_widget",
) {
  const store = {
    change: async (id: string, action: (w: Workspace) => unknown) => {
      if (id !== w.id) throw Error("not_found");
      return action(w);
    },
    deployment: async () => deployment,
  } as Store;
  const found = applicationTools(
    store,
    workspaceId,
    r.id,
    fence,
    undefined,
    r.workflowId ? "workflow" : "interactive",
  ).find((t) => t.name === name);
  if (!found) throw Error(`tool missing: ${name}`);
  return found;
}
test("private answers receive proactive selection guidance and load rendering details on demand", () => {
  const { w, r } = fixture();
  for (const task of [
    "Compare these three plans",
    "How does the cost change if we double the team?",
    "Hello",
    "What is 2 + 2? Text only.",
  ]) {
    r.task = task;
    const context = buildContext(w, r);
    expect(JSON.parse(context.prompt).request).toBe(task);
    expect(context.system).toContain("Proactively use send_telegram_widget");
    expect(context.system).toContain("Honor text-only requests");
    expect(context.system).toContain("use text for simple facts");
    expect(context.system).not.toContain("## Observable design checks");
  }
});
test("proactive selection guidance requires a private bot thread and an authorized pinned widget guide", () => {
  const { w, r } = fixture();
  expect(telegramWidgetAvailable(w, r)).toBe(true);
  for (const mutate of [
    (_w: Workspace, r: Run) => {
      r.workflowId = "scheduled";
    },
    (_w: Workspace, r: Run) => {
      r.chatId = "-100100";
    },
    (_w: Workspace, r: Run) => {
      r.threadId = undefined;
    },
    (_w: Workspace, r: Run) => {
      r.actor = "202";
    },
    (_w: Workspace, r: Run) => {
      r.topicId = 8;
    },
    (_w: Workspace, r: Run) => {
      r.skillPins = [];
    },
    (w: Workspace) => {
      w.settings.paused = true;
    },
    (w: Workspace) => {
      required(w.members[0]).active = false;
    },
    (w: Workspace) => {
      required(w.threads?.[0]).botId = undefined;
    },
    (w: Workspace) => {
      required(
        w.skills.find((s) => s.draft.slug === "telegram-widgets"),
      ).enabled = false;
    },
    (w: Workspace) => {
      required(
        w.skills.find((s) => s.draft.slug === "telegram-widgets"),
      ).archived = true;
    },
    (w: Workspace) => {
      const spec = required(
        w.skills.find((s) => s.draft.slug === "telegram-widgets")?.published[0],
      );
      spec.tools = spec.tools.filter((t) => t !== "send_telegram_widget");
    },
    (w: Workspace) => {
      required(
        w.skills.find((s) => s.draft.slug === "telegram-widgets")?.published[0],
      ).resources = [];
    },
  ]) {
    const copy = structuredClone({ w, r });
    mutate(copy.w, copy.r);
    expect(telegramWidgetAvailable(copy.w, copy.r)).toBe(false);
  }
  const group = fixture("-100100");
  expect(buildContext(group.w, group.r).system).not.toContain(
    "Proactively use send_telegram_widget",
  );
  const preset = required(
    w.skills.find((s) => s.draft.slug === "telegram-widgets"),
  );
  changeSkill(w, "101", preset.id, preset.version, "disable");
  const next = createRun(
    w,
    "101",
    "Compare these plans",
    "101",
    7,
    "gpt-4.1-mini",
    { botId: "999" },
  );
  expect(buildContext(w, next).system).not.toContain(
    "Proactively use send_telegram_widget",
  );
});
test("widget calls stage once, replay durably and publish only with a successful answer", async () => {
  const { w, r } = fixture();
  const t = tool(w, r);
  const first = await t.execute("widget", args);
  expect(await t.execute("widget", args)).toEqual(first);
  await t.execute("second", args);
  expect(w.deliveries).toHaveLength(0);
  for (const status of [
    "running",
    "partial",
    "failed",
    "awaiting_approval",
    "cancelled",
  ] as const) {
    r.status = status;
    publishWidget(w, r, "999");
    expect(w.deliveries).toHaveLength(0);
  }
  r.status = "succeeded";
  publishWidget(w, r, "999");
  publishWidget(w, r, "999");
  expect(w.deliveries).toHaveLength(1);
  expect(w.deliveries[0]).toMatchObject({
    actor: "101",
    chatId: "101",
    topicId: 7,
    replyTo: 42,
    botId: "999",
    text: args.caption,
  });
  expect(widgetDeliveryAllowed(w, required(w.deliveries[0]), "999")).toBe(true);
});
test("widget tool validates UTF-8 and compressed limits, NUL, dimensions and model-controlled fields", () => {
  const { w, r } = fixture();
  for (const invalid of [
    { ...args, html: "\0" },
    { ...args, html: "界".repeat(11000) },
    { ...args, html: randomBytes(5000).toString("hex") },
    { ...args, caption: " " },
    { ...args, caption: "a".repeat(1025) },
    { ...args, width: 199 },
    { ...args, height: 601 },
    { ...args, chat_id: "202" },
    { ...args, allow_queries: true },
    { ...args, is_shared: true },
    { ...args, public_data: "secret" },
  ])
    expect(() => authorizeWidget(w, r, invalid)).toThrow();
  expect(() =>
    authorizeWidget(w, r, { ...args, html: "a".repeat(32768) }),
  ).not.toThrow();
});
test("widgets reject groups, invalid workflows, absent threads and rotated bots", async () => {
  const group = fixture("-100100");
  expect(() => stageWidget(group.w, group.r, args, "999")).toThrow(
    "widget_private_chat_required",
  );
  for (const patch of [{ threadId: undefined }, { topicId: 8 }]) {
    const { w, r } = fixture();
    Object.assign(r, patch);
    expect(() => stageWidget(w, r, args, "999")).toThrow(
      "widget_private_thread_required",
    );
  }
  const invalid = fixture();
  invalid.r.workflowId = "missing";
  expect(() => stageWidget(invalid.w, invalid.r, args, "999")).toThrow(
    "widget_workflow_changed",
  );
  const { w, r } = fixture();
  const deployment = { active: true, paused: false, bot: { id: "999" } };
  const t = tool(w, r, deployment);
  await t.execute("widget", args);
  deployment.bot.id = "1000";
  await expect(t.execute("widget", args)).rejects.toThrow("widget_bot_changed");
});
test.each([0, 7])(
  "scheduled private destination %i stages and publishes once without a conversation thread",
  async (topicId) => {
    const { w, r } = scheduledFixture(topicId);
    expect(r.threadId).toBeUndefined();
    expect(telegramWidgetAvailable(w, r)).toBe(true);
    expect(buildContext(w, r).system).toContain(
      "Proactively use send_telegram_widget",
    );
    const deployment = { active: true, paused: false, bot: { id: "999" } };
    const t = tool(w, r, deployment);
    const first = await t.execute("widget", args);
    expect(await t.execute("widget", args)).toEqual(first);
    expect(w.deliveries).toHaveLength(0);
    deployment.bot.id = "1000";
    await expect(t.execute("widget", args)).rejects.toThrow(
      "widget_bot_changed",
    );
    await expect(t.execute("revision", args)).rejects.toThrow(
      "widget_bot_changed",
    );
    deployment.bot.id = "999";
    r.status = "succeeded";
    publishWidget(w, r, "999");
    publishWidget(w, r, "999");
    expect(w.deliveries).toHaveLength(1);
    const d = required(w.deliveries[0]);
    expect(d).toMatchObject({
      chatId: "101",
      topicId,
      botId: "999",
      text: args.caption,
    });
    expect(d.replyTo).toBeUndefined();
    expect(widgetDeliveryAllowed(w, d, "999")).toBe(true);
    expect(widgetDeliveryAllowed(w, d, "1000")).toBe(false);
  },
);
test("private schedules add the enabled built-in presentation skill without changing selected versions or old pins", () => {
  for (const selection of ["none", "other", "widget"] as const) {
    const { w, r, f } = scheduledFixture();
    const widget = required(
      w.skills.find((s) => s.draft.slug === "telegram-widgets"),
    );
    const selected = selection === "widget" ? widget : required(w.skills[0]);
    f.spec.skillId = selection === "none" ? undefined : selected.id;
    Object.assign(f, { skillVersion: 1 });
    widget.published.push(structuredClone(widget.draft));
    const originalPins = structuredClone(r.skillPins);
    const next = createRun(w, "101", f.spec.task, "101", 7, "gpt-4.1-mini", {
      workflowId: f.id,
    });
    expect(next.skillPins.filter((p) => p.id === widget.id)).toEqual([
      { id: widget.id, version: selection === "widget" ? 1 : 2 },
    ]);
    if (selection === "other")
      expect(next.skillPins).toContainEqual({ id: selected.id, version: 1 });
    expect(r.skillPins).toEqual(originalPins);
  }
  for (const mutate of [
    (w: Workspace) => {
      required(
        w.skills.find((s) => s.draft.slug === "telegram-widgets"),
      ).enabled = false;
    },
    (w: Workspace) => {
      required(
        w.skills.find((s) => s.draft.slug === "telegram-widgets"),
      ).archived = true;
    },
    (w: Workspace) => {
      required(
        w.skills.find((s) => s.draft.slug === "telegram-widgets"),
      ).preset = false;
    },
    (w: Workspace) => {
      required(
        w.skills.find((s) => s.draft.slug === "telegram-widgets"),
      ).origin = {
        runId: "imported",
        actor: "101",
        sharedAt: new Date().toISOString(),
        references: memoryReferences([]),
      };
    },
    (w: Workspace) => {
      required(
        w.skills.find((s) => s.draft.slug === "telegram-widgets"),
      ).githubSource = {
        repository: "example/skills",
        ref: "main",
        path: "telegram-widgets/SKILL.md",
        commit: "a".repeat(40),
        blobSha: "b".repeat(40),
        draftHash: "c".repeat(64),
        importedAt: new Date().toISOString(),
        access: "public",
      };
    },
    (w: Workspace) => {
      w.skills = w.skills.filter((s) => s.draft.slug !== "telegram-widgets");
    },
  ]) {
    const { w, f } = scheduledFixture();
    mutate(w);
    const next = createRun(w, "101", f.spec.task, "101", 7, "gpt-4.1-mini", {
      workflowId: f.id,
    });
    expect(next.skillPins).toEqual([]);
    expect(telegramWidgetAvailable(w, next)).toBe(false);
  }
  const group = scheduledFixture(7, "-100100");
  expect(group.r.skillPins).toEqual([]);
  expect(() => stageWidget(group.w, group.r, args, "999")).toThrow(
    "widget_private_chat_required",
  );
});
test("scheduled widgets recheck owner, workflow version, status and exact saved destination", async () => {
  for (const mutate of [
    (w: Workspace) => {
      required(w.workflows[0]).owner = "202";
    },
    (w: Workspace) => {
      required(w.workflows[0]).version++;
    },
    (w: Workspace) => {
      required(w.workflows[0]).status = "paused";
    },
    (w: Workspace) => {
      required(w.workflows[0]).spec.chatId = "202";
    },
    (w: Workspace) => {
      required(w.workflows[0]).spec.topicId = 8;
    },
    (w: Workspace) => {
      w.workflows = [];
    },
  ]) {
    const { w, r } = scheduledFixture();
    await tool(w, r).execute("widget", args);
    r.status = "succeeded";
    publishWidget(w, r, "999");
    const d = required(w.deliveries[0]);
    mutate(w);
    expect(widgetDeliveryAllowed(w, d, "999")).toBe(false);
    r.status = "running";
    await expect(tool(w, r).execute("widget", args)).rejects.toThrow();
  }
  for (const mutate of [
    (w: Workspace) => {
      required(w.members[0]).active = false;
    },
    (w: Workspace) => {
      w.settings.paused = true;
    },
    (w: Workspace) => {
      required(
        w.skills.find((s) => s.draft.slug === "telegram-widgets"),
      ).enabled = false;
    },
    (_w: Workspace, r: Run) => {
      r.cancelled = true;
    },
    (_w: Workspace, r: Run) => {
      r.skillPins = [];
    },
  ]) {
    const { w, r } = scheduledFixture();
    mutate(w, r);
    await expect(tool(w, r).execute("widget", args)).rejects.toThrow();
    expect(r.widget).toBeUndefined();
  }
});
test("supplementary presentation pins retain free-form cost access without granting it to selected procedures", async () => {
  const { w, r, f } = scheduledFixture();
  expect(r.skillPins).toHaveLength(1);
  await expect(
    tool(w, r, undefined, w.id, r.fence, "query_model_cost").execute("cost", {
      scope: "self",
    }),
  ).resolves.toBeDefined();
  f.spec.skillId = r.skillPins[0]?.id;
  f.skillVersion = 1;
  const selected = createRun(w, "101", f.spec.task, "101", 7, "gpt-4.1-mini", {
    workflowId: f.id,
  });
  selected.status = "running";
  await expect(
    tool(
      w,
      selected,
      undefined,
      w.id,
      selected.fence,
      "query_model_cost",
    ).execute("cost", {}),
  ).rejects.toThrow("tool_not_granted");
});
test("widget grants, membership, tenant, fence, cancellation and changed call arguments are enforced", async () => {
  for (const mutate of [
    (w: Workspace) => {
      required(w.members[0]).active = false;
    },
    (_w: Workspace, r: Run) => {
      r.cancelled = true;
    },
    (w: Workspace) => {
      w.settings.paused = true;
    },
    (w: Workspace) => {
      required(
        w.skills.find((s) => s.draft.slug === "telegram-widgets"),
      ).enabled = false;
    },
    (_w: Workspace, r: Run) => {
      r.skillPins = [];
    },
  ]) {
    const { w, r } = fixture();
    mutate(w, r);
    await expect(tool(w, r).execute("widget", args)).rejects.toThrow();
    expect(r.widget).toBeUndefined();
  }
  const { w, r } = fixture();
  await expect(
    tool(w, r, undefined, "another-tenant").execute("widget", args),
  ).rejects.toThrow("not_found");
  await expect(
    tool(w, r, undefined, w.id, 99).execute("widget", args),
  ).rejects.toThrow("tool_policy_denied");
  const t = tool(w, r);
  await t.execute("widget", args);
  await expect(
    t.execute("widget", { ...args, caption: "Changed" }),
  ).rejects.toThrow("tool_call_conflict");
  await t.execute("revision", { ...args, caption: "Changed" });
  await t.execute("widget", args);
  expect(r.widget?.caption).toBe("Changed");
});
test("delivery payload cannot cross actors, Topics, bot identity or staged contents", () => {
  const { w, r } = fixture();
  stageWidget(w, r, args, "999");
  r.status = "succeeded";
  publishWidget(w, r, "999");
  const d = required(w.deliveries[0]);
  for (const patch of [
    { actor: "202" },
    { chatId: "202" },
    { topicId: 8 },
    { replyTo: 99 },
    { text: "changed" },
    { widget: { ...required(d.widget), html: "changed" } },
  ]) {
    expect(widgetDeliveryAllowed(w, { ...d, ...patch }, "999")).toBe(false);
  }
  expect(widgetDeliveryAllowed(w, d, "other")).toBe(false);
});
test("new live input suppresses a stale staged widget until it is revised for that message", async () => {
  const { w, r } = fixture();
  const t = tool(w, r);
  await t.execute("initial", args);
  r.replyTo = 43;
  r.status = "succeeded";
  publishWidget(w, r, "999");
  expect(w.deliveries).toHaveLength(0);
  r.status = "running";
  await t.execute("revision", { ...args, caption: "Revised estimate" });
  await t.execute("initial", args);
  r.status = "succeeded";
  publishWidget(w, r, "999");
  expect(w.deliveries[0]).toMatchObject({
    replyTo: 43,
    text: "Revised estimate",
  });
  expect(w.deliveries).toHaveLength(1);
});
test("preset upgrade is stable and preserves disablement, collisions and existing pins", () => {
  const { w, r } = fixture();
  w.skills = w.skills.filter((s) => s.draft.slug !== "telegram-widgets");
  const pins = structuredClone(r.skillPins);
  ensureTelegramWidgetSkill(w);
  const preset = required(w.skills.at(-1));
  expect(preset).toMatchObject({
    preset: true,
    enabled: true,
  });
  expect(z.uuid().safeParse(preset.id).success).toBe(true);
  ensureTelegramWidgetSkill(w);
  expect(
    w.skills.filter((s) => s.draft.slug === "telegram-widgets"),
  ).toHaveLength(1);
  expect(r.skillPins).toEqual(pins);
  changeSkill(w, "101", preset.id, preset.version, "disable");
  ensureTelegramWidgetSkill(w);
  expect(preset.enabled).toBe(false);
  preset.preset = false;
  ensureTelegramWidgetSkill(w);
  expect(w.skills.at(-1)).toBe(preset);
});
test.each([originalTelegramWidgetSpec, proactiveTelegramWidgetSpec])(
  "previous presets upgrade once at catalog capacity, preserving disablement, versions and run pins: %p",
  (previousSpec) => {
    for (const enabled of [true, false]) {
      const w = workspace();
      const preset = required(
        w.skills.find((s) => s.draft.slug === "telegram-widgets"),
      );
      const original = previousSpec();
      preset.draft = structuredClone(original);
      preset.published = [structuredClone(original)];
      const old = createRun(
        w,
        "101",
        "Compare plans",
        "101",
        7,
        "gpt-4.1-mini",
        {
          botId: "999",
        },
      );
      const pins = structuredClone(old.skillPins);
      preset.enabled = enabled;
      const revision = preset.version;
      while (w.skills.length < 100) {
        const copy = structuredClone(required(w.skills[0]));
        copy.id = randomUUID();
        copy.draft.slug = `extra-${w.skills.length}`;
        w.skills.push(copy);
      }
      ensureTelegramWidgetSkill(w);
      expect(preset.enabled).toBe(enabled);
      expect(preset.version).toBe(revision + 1);
      expect(preset.published).toHaveLength(2);
      expect(preset.published[0]).toEqual(original);
      expect(preset.draft.body).toContain("The user does not need to say");
      expect(old.skillPins).toEqual(pins);
      if (enabled) {
        expect(
          buildContext(w, old).skills.find((s) => s.id === preset.id)?.content,
        ).toContain(original.body);
        const next = createRun(
          w,
          "101",
          "Compare plans",
          "101",
          7,
          "gpt-4.1-mini",
          { botId: "999" },
        );
        expect(next.skillPins.find((p) => p.id === preset.id)?.version).toBe(2);
      }
      ensureTelegramWidgetSkill(w);
      expect(preset.published).toHaveLength(2);
      expect(preset.version).toBe(revision + 1);
    }
  },
);
test("automatic preset updates preserve custom collisions, changed instructions and archived records", () => {
  for (const mutate of [
    (skill: Workspace["skills"][number]) => {
      skill.preset = false;
    },
    (skill: Workspace["skills"][number]) => {
      skill.preset = undefined;
    },
    (skill: Workspace["skills"][number]) => {
      skill.archived = true;
    },
    (skill: Workspace["skills"][number]) => {
      skill.draft.body += " Custom instructions.";
    },
    (skill: Workspace["skills"][number]) => {
      required(skill.published[0]).tools = [];
    },
  ]) {
    const w = workspace();
    const preset = required(
      w.skills.find((s) => s.draft.slug === "telegram-widgets"),
    );
    preset.draft = originalTelegramWidgetSpec();
    preset.published = [originalTelegramWidgetSpec()];
    mutate(preset);
    const before = structuredClone(w.skills);
    ensureTelegramWidgetSkill(w);
    expect(w.skills).toEqual(before);
  }
});
test("private Browser widget contents are encrypted with runs and deliveries and erased with sources", () => {
  const { w, r } = fixture();
  stageWidget(w, r, args, "999");
  r.status = "succeeded";
  publishWidget(w, r, "999");
  r.browserRead = { owner: "101", botId: "999", generation: 1, epoch: 0 };
  const key = "ab".repeat(32);
  const encoded = encodeBrowserWorkspace(w, key);
  expect(encoded.runs[0]?.widget).toBeUndefined();
  expect(encoded.deliveries[0]?.widget).toBeUndefined();
  expect(JSON.stringify(encoded)).not.toContain(args.html);
  expect(decodeBrowserWorkspace(encoded, key).runs[0]?.widget).toEqual(
    r.widget,
  );
  w.messages = [];
  sweep(w);
  expect(r.widget).toBeUndefined();
  expect(w.deliveries[0]?.widget).toBeUndefined();
  expect(w.deliveries[0]?.state).toBe("cancelled");
});
