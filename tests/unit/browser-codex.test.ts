import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  signBrowserCapability,
  verifyBrowserCapability,
} from "../../src/browser/capability.ts";
import { JobTaskChannel } from "../../src/coding/local/job-channel.ts";

test("browser capabilities bind actor, tenant, task and attempt, expire, and reject tampering", () => {
  const key = "ac".repeat(32),
    cap = {
      workspaceId: randomUUID(),
      actor: "202",
      taskId: randomUUID(),
      attemptId: randomUUID(),
      fence: 3,
      configuration: 2,
      epoch: 1,
      botId: "999",
      expiresAt: Date.now() + 60000,
    };
  const token = signBrowserCapability(key, cap);
  expect(verifyBrowserCapability(key, token)).toEqual(cap);
  const body = Buffer.from(JSON.stringify({ ...cap, actor: "101" })).toString(
    "base64url",
  );
  expect(() =>
    verifyBrowserCapability(key, `${body}.${token.split(".")[1]}`),
  ).toThrow("browser_unauthorized");
  expect(() =>
    verifyBrowserCapability(
      key,
      signBrowserCapability(key, { ...cap, expiresAt: 1 }),
    ),
  ).toThrow("browser_authorization_expired");
  expect(() => verifyBrowserCapability(key, `${token}.extra`)).toThrow(
    "browser_unauthorized",
  );
});
test("Codex registers Browser only when granted and polls a wait without replaying invocation", async () => {
  const calls: { command: string; callId?: string; id?: string }[] = [],
    id = randomUUID();
  const channel = new JobTaskChannel(
    "http://runner.test",
    "attempt-token",
    (async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer attempt-token",
      );
      const call = JSON.parse(String(init?.body));
      calls.push(call);
      return Response.json(
        call.command === "invoke"
          ? { status: "waiting", requestId: id }
          : { status: "completed", inputApplied: true },
      );
    }) as typeof fetch,
    undefined,
    true,
  );
  expect(channel.tools.map((t) => t.name)).toContain("browser_action");
  const value = {
    action: "request_input",
    selector: "#password",
    label: "Password",
    kind: "password",
  };
  const first = channel.handle("browser-native-call", "browser_action", value),
    duplicate = channel.handle("browser-native-call", "browser_action", value);
  expect(await first).toMatchObject({ success: true });
  expect(await duplicate).toEqual(await first);
  expect(calls.map((c) => c.command)).toEqual(["invoke", "poll"]);
  channel.close();
  const disabled = new JobTaskChannel(
    "http://runner.test",
    "attempt-token",
    (async () => {
      throw Error("Unexpected network");
    }) as unknown as typeof fetch,
  );
  expect(disabled.tools.some((t) => t.name.startsWith("browser_"))).toBe(false);
  expect(
    await disabled.handle("denied", "browser_action", { action: "read" }),
  ).toMatchObject({ success: false });
});
