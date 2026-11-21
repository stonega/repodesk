import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { validateResult } from "../../src/plugins/invocation.ts";
import { generateContract, parseManifest } from "../../src/plugins/manifest.ts";
import { managePluginNotifications } from "../../src/plugins/notifications.ts";
import { workspace } from "../fixtures.ts";

const raw = JSON.parse(
  await readFile("examples/plugins/word-count/telo.plugin.json", "utf8"),
);
function manifest() {
  const m = structuredClone(raw);
  m.capabilities = ["notifications.publish"];
  m.notifications = [
    { name: "updated", title: "Updated", description: "A new observed item." },
  ];
  m.tools[0].effect = "read";
  m.tools[0].capabilities = ["notifications.publish"];
  return parseManifest(m);
}
const notice = () => ({
  event: "updated",
  id: "upstream-item-123",
  title: "A new item",
  body: "Observed upstream change.",
  occurredAt: new Date().toISOString(),
  url: "https://example.com/item/123",
});
const result = () => ({
  content: [{ type: "text", text: "1" }],
  structuredContent: { count: 1 },
  notifications: [notice()],
});
test("notification declarations require explicit capabilities and generate typed event names", () => {
  const m = manifest();
  expect(generateContract(m)).toContain(
    'export type NotificationEvent = "updated"',
  );
  expect(validateResult(m, "count_words", result()).notifications).toHaveLength(
    1,
  );
  expect(() => parseManifest({ ...m, capabilities: [] })).toThrow(
    "plugin_manifest_invalid",
  );
  expect(() => parseManifest({ ...m, notifications: undefined })).toThrow(
    "plugin_manifest_invalid",
  );
  expect(() =>
    parseManifest({
      ...m,
      notifications: [...(m.notifications ?? []), ...(m.notifications ?? [])],
    }),
  ).toThrow("plugin_manifest_invalid");
});
test.each([
  { event: "undeclared" },
  { chatId: "202" },
  { actor: "202" },
  { url: "https://user:secret@example.com/item" },
  { url: "javascript:alert(1)" },
  { occurredAt: "not-a-date" },
  { body: "x".repeat(2001) },
])(
  "candidate events reject undeclared, forged and invalid fields %#",
  (patch) => {
    expect(() =>
      validateResult(manifest(), "count_words", {
        ...result(),
        notifications: [{ ...notice(), ...patch }],
      }),
    ).toThrow("plugin_result_invalid");
  },
);
test("a package capability does not expand another tool's event ceiling", () => {
  const m = manifest();
  const tool = m.tools[0];
  if (tool) tool.capabilities = [];
  expect(() => validateResult(m, "count_words", result())).toThrow(
    "plugin_result_invalid",
  );
  expect(() =>
    validateResult(m, "count_words", { ...result(), notifications: [] }),
  ).toThrow("plugin_result_invalid");
  const repeated = result();
  repeated.notifications.push(
    repeated.notifications[0] as ReturnType<typeof notice>,
  );
  expect(() => validateResult(manifest(), "count_words", repeated)).toThrow(
    "plugin_result_invalid",
  );
});
test("subscription management never adopts another actor's records or an unknown plugin", () => {
  const w = workspace();
  expect(
    managePluginNotifications(w, "101", "900", { action: "list" }),
  ).toEqual({ subscriptions: [], plugins: [] });
  expect(() =>
    managePluginNotifications(w, "101", "900", {
      action: "subscribe",
      plugin: "unknown",
    }),
  ).toThrow("notification_plugin_unavailable");
  expect(() =>
    managePluginNotifications(w, "unknown", "900", { action: "list" }),
  ).toThrow("access_denied");
  expect(() =>
    managePluginNotifications(w, "101", "900", {
      action: "subscribe",
      plugin: "anything",
      chatId: "202",
    }),
  ).toThrow();
});
