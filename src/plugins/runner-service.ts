import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { assertJson, type Json, limits, PluginError } from "./contract.ts";
import type { PluginSandbox } from "./docker-sandbox.ts";
import {
  validateInput,
  validateResult,
  validateSettings,
} from "./invocation.ts";
import { parseManifest } from "./manifest.ts";
import { type BrokerRequest, errorCodes } from "./protocol.ts";

export type RunnerEvent =
  | { type: "broker"; id: string; request: BrokerRequest }
  | { type: "result"; value: Json }
  | { type: "error"; code: (typeof errorCodes)[number] };
interface Call {
  controller: AbortController;
  events: RunnerEvent[];
  pending: Map<
    string,
    { resolve: (value: Json) => void; reject: (error: Error) => void }
  >;
  done: boolean;
  completion: Promise<void>;
  expires: number;
}
const startSchema = z
  .object({
    manifest: z.json(),
    bundle: z
      .string()
      .min(4)
      .max(Math.ceil(limits.bundle / 3) * 4),
    bundleHash: z.string().regex(/^[a-f0-9]{64}$/),
    tool: z.string().max(32),
    arguments: z.json(),
    settings: z.json(),
    grants: z.array(z.enum(["github.metadata.read", "http.read"])).max(2),
    timeoutMs: z.number().int().positive().max(limits.deadlineMs).optional(),
  })
  .strict();
const replySchema = z
  .object({
    id: z.string().uuid(),
    response: z.union([
      z.object({ result: z.json() }).strict(),
      z.object({ error: z.enum(errorCodes) }).strict(),
    ]),
  })
  .strict();
const authorized = (expected: string, presented: string) => {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Private supervisor API. It owns Docker, not application credentials or policy. */
export function pluginRunnerApp(sandbox: PluginSandbox, token: string) {
  if (token.length < 32) throw new PluginError("plugin_unavailable");
  const calls = new Map<string, Call>();
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 8 * 1024 * 1024 }));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (
      !authorized(
        token,
        c.req.header("authorization")?.replace(/^Bearer /, "") ?? "",
      )
    )
      return c.json({ error: "plugin_permission_denied" }, 403);
    for (const [id, call] of calls)
      if (call.expires < Date.now()) {
        call.controller.abort();
        calls.delete(id);
      }
    await next();
  });
  app.get("/healthz", (c) => c.json({ protocolVersion: 1 }));
  app.post("/invocations", async (c) => {
    if (
      calls.size >= 64 ||
      [...calls.values()].filter((call) => !call.done).length >= 4
    )
      throw new PluginError("plugin_unavailable");
    const value = startSchema.parse(await c.req.json());
    const manifest = parseManifest(value.manifest);
    const args = validateInput(manifest, value.tool, value.arguments);
    const settings = validateSettings(manifest, value.settings);
    const bundle = Buffer.from(value.bundle, "base64");
    if (
      bundle.toString("base64") !== value.bundle ||
      bundle.length > limits.bundle
    )
      throw new PluginError("plugin_package_invalid");
    const id = randomUUID();
    const call: Call = {
      controller: new AbortController(),
      events: [],
      pending: new Map(),
      done: false,
      completion: Promise.resolve(),
      expires: Date.now() + 60000,
    };
    calls.set(id, call);
    call.completion = sandbox
      .invoke({
        manifest,
        arguments: args,
        settings,
        tool: value.tool,
        bundle,
        bundleHash: value.bundleHash,
        grants: value.grants,
        signal: call.controller.signal,
        timeoutMs: value.timeoutMs,
        guard: async () => {
          call.controller.signal.throwIfAborted();
        },
        broker: (request) =>
          new Promise((resolve, reject) => {
            if (
              call.pending.size ||
              call.events.length >= limits.brokerRequests
            ) {
              reject(new PluginError("plugin_protocol_invalid"));
              return;
            }
            const requestId = randomUUID();
            call.pending.set(requestId, { resolve, reject });
            call.events.push({ type: "broker", id: requestId, request });
          }),
      })
      .then((result) => {
        call.events.push({
          type: "result",
          value: validateResult(
            manifest,
            value.tool,
            result,
          ) as unknown as Json,
        });
      })
      .catch((error) => {
        call.events.push({
          type: "error",
          code:
            error instanceof PluginError
              ? error.code
              : "plugin_execution_failed",
        });
      })
      .finally(() => {
        call.done = true;
        for (const waiter of call.pending.values())
          waiter.reject(new PluginError("plugin_cancelled"));
        call.pending.clear();
      });
    return c.json({ id });
  });
  app.get("/invocations/:id", (c) => {
    const call = calls.get(c.req.param("id"));
    if (!call) throw new PluginError("plugin_outcome_unknown");
    const cursor = z.coerce
      .number()
      .int()
      .min(0)
      .max(11)
      .parse(c.req.query("cursor") ?? "0");
    if (cursor > call.events.length)
      throw new PluginError("plugin_protocol_invalid");
    return c.json({ events: call.events.slice(cursor), done: call.done });
  });
  app.post("/invocations/:id/responses", async (c) => {
    const call = calls.get(c.req.param("id"));
    const value = replySchema.parse(await c.req.json());
    assertJson(value.response, limits.result);
    const pending = call?.pending.get(value.id);
    if (!call || call.done || !pending)
      throw new PluginError("plugin_protocol_invalid");
    call.pending.delete(value.id);
    if ("error" in value.response)
      pending.reject(new PluginError(value.response.error));
    else pending.resolve(value.response.result);
    return c.json({ accepted: true });
  });
  app.delete("/invocations/:id", async (c) => {
    const call = calls.get(c.req.param("id"));
    if (call) {
      call.controller.abort();
      await call.completion;
      calls.delete(c.req.param("id"));
    }
    return c.json({ removed: true });
  });
  app.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof PluginError ? error.code : "plugin_protocol_invalid",
      },
      409,
    ),
  );
  return app;
}
