import { expect, test } from "bun:test";
import {
  FrameReader,
  HostSession,
  parseFrame,
} from "../../src/plugins/protocol.ts";

const ready = { jsonrpc: "2.0", id: "initialize", result: 1 } as const;
const broker = {
  jsonrpc: "2.0",
  id: "p1",
  method: "broker.request",
  params: { method: "github.repository.get", params: { repositoryId: 123 } },
} as const;
test("framing handles fragmented and combined messages", () => {
  const reader = new FrameReader();
  const bytes = Buffer.from(
    `${JSON.stringify(ready)}\n${JSON.stringify(broker)}\n`,
  );
  expect(reader.feed(bytes.subarray(0, 4))).toEqual([]);
  expect(reader.feed(bytes.subarray(4))).toEqual([ready, broker]);
  reader.finish();
});
test.each(["not JSON\n", "{}\n", "\n", `${"x".repeat(262145)}\n`])(
  "invalid subprocess output is sanitized %#",
  (bytes) => {
    expect(() => new FrameReader().feed(Buffer.from(bytes))).toThrow(
      "plugin_protocol_invalid",
    );
  },
);
test("incomplete frame and unknown identity fields fail closed", () => {
  const reader = new FrameReader();
  reader.feed(Buffer.from("{"));
  expect(() => reader.finish()).toThrow("plugin_protocol_invalid");
  expect(() => parseFrame({ ...broker, workspaceId: "other" })).toThrow(
    "plugin_protocol_invalid",
  );
  expect(() => parseFrame({ ...broker, method: "shell.exec" })).toThrow(
    "plugin_protocol_invalid",
  );
  expect(() =>
    parseFrame({
      jsonrpc: "2.0",
      id: "p1",
      error: { code: "plugin_execution_failed", message: "secret" },
    }),
  ).toThrow("plugin_protocol_invalid");
});
test("host protocol rejects pre-initialization, duplicate and late requests", () => {
  const session = new HostSession();
  expect(() => session.accept(broker)).toThrow("plugin_protocol_invalid");
  const good = new HostSession();
  expect(good.accept(ready)).toBe("initialized");
  good.invoke();
  expect(good.accept(broker)).toBe("broker");
  expect(() => good.accept(broker)).toThrow("plugin_protocol_invalid");
  expect(good.accept({ jsonrpc: "2.0", id: "invoke", result: {} })).toBe(
    "result",
  );
  expect(() => good.accept({ ...broker, id: "p2" })).toThrow(
    "plugin_protocol_invalid",
  );
});
test("per-call broker request count is bounded", () => {
  const session = new HostSession();
  session.accept(ready);
  session.invoke();
  for (let n = 1; n <= 10; n++)
    expect(session.accept({ ...broker, id: `p${n}` })).toBe("broker");
  expect(() => session.accept({ ...broker, id: "p11" })).toThrow(
    "plugin_protocol_invalid",
  );
});
