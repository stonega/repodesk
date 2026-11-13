import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  type Json,
  limits,
  PluginError,
  type PluginErrorCode,
  type ToolResult,
} from "./contract.ts";
import type { PluginSandbox, SandboxInvocation } from "./docker-sandbox.ts";
import { boundedBody } from "./github-source.ts";
import { authorizeBroker, validateResult } from "./invocation.ts";
import { brokerRequestSchema, errorCodes } from "./protocol.ts";

const eventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("broker"),
      id: z.string().uuid(),
      request: brokerRequestSchema,
    })
    .strict(),
  z.object({ type: z.literal("result"), value: z.json() }).strict(),
  z.object({ type: z.literal("error"), code: z.enum(errorCodes) }).strict(),
]);

/** The worker only has this client. Docker access stays in the private supervisor. */
export class PluginRunnerClient implements PluginSandbox {
  readonly origin: string;
  constructor(
    origin: string,
    private token: string | (() => string),
    private transport: typeof fetch = fetch,
  ) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      (typeof token === "string" && token.length < 32)
    )
      throw new PluginError("plugin_unavailable");
    this.origin = origin;
  }
  private async request(
    path: string,
    method: string,
    body: unknown,
    signal: AbortSignal,
  ) {
    const token = typeof this.token === "function" ? this.token() : this.token;
    if (token.length < 32) throw new PluginError("plugin_unavailable");
    const response = await this.transport(this.origin + path, {
      method,
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value: unknown = JSON.parse(
      (await boundedBody(response, limits.result + 8192)).toString("utf8"),
    );
    if (!response.ok) {
      const error = z.object({ error: z.enum(errorCodes) }).safeParse(value);
      throw new PluginError(
        error.success ? error.data.error : "plugin_unavailable",
      );
    }
    return value;
  }
  async invoke(input: SandboxInvocation): Promise<ToolResult> {
    const timeout = AbortSignal.timeout(
      Math.min(input.timeoutMs ?? limits.deadlineMs, limits.deadlineMs) + 5000,
    );
    const signal = AbortSignal.any([input.signal, timeout]);
    let id: string | undefined;
    try {
      await input.guard();
      signal.throwIfAborted();
      const started = z
        .object({ id: z.string().uuid() })
        .strict()
        .parse(
          await this.request(
            "/invocations",
            "POST",
            {
              manifest: input.manifest,
              bundle: input.bundle.toString("base64"),
              bundleHash: input.bundleHash,
              tool: input.tool,
              arguments: input.arguments,
              settings: input.settings,
              grants: input.grants,
              timeoutMs: input.timeoutMs,
            },
            signal,
          ),
        );
      id = started.id;
      let cursor = 0;
      let brokerCount = 0;
      const seen = new Set<string>();
      while (true) {
        await input.guard();
        signal.throwIfAborted();
        const poll = z
          .object({ events: z.array(eventSchema).max(11), done: z.boolean() })
          .strict()
          .parse(
            await this.request(
              `/invocations/${id}?cursor=${cursor}`,
              "GET",
              undefined,
              signal,
            ),
          );
        for (const event of poll.events) {
          cursor++;
          if (event.type === "error") throw new PluginError(event.code);
          if (event.type === "result") {
            await input.guard();
            signal.throwIfAborted();
            return validateResult(input.manifest, input.tool, event.value);
          }
          if (seen.has(event.id) || ++brokerCount > limits.brokerRequests)
            throw new PluginError("plugin_protocol_invalid");
          seen.add(event.id);
          const request = authorizeBroker(
            input.manifest,
            input.tool,
            input.grants,
            event.request,
          );
          await input.guard();
          signal.throwIfAborted();
          let reply: { result: Json } | { error: PluginErrorCode };
          try {
            const result = await input.broker(request, signal);
            await input.guard();
            signal.throwIfAborted();
            reply = { result };
          } catch (error) {
            reply = {
              error:
                error instanceof PluginError
                  ? error.code
                  : "plugin_execution_failed",
            };
          }
          await this.request(
            `/invocations/${id}/responses`,
            "POST",
            { id: event.id, response: reply },
            signal,
          );
        }
        if (poll.done) throw new PluginError("plugin_outcome_unknown");
        await delay(50, undefined, { signal });
      }
    } catch (error) {
      if (input.signal.aborted) throw new PluginError("plugin_cancelled");
      if (timeout.aborted) throw new PluginError("plugin_timeout");
      if (error instanceof PluginError) throw error;
      throw new PluginError(
        id ? "plugin_outcome_unknown" : "plugin_unavailable",
      );
    } finally {
      if (id)
        await this.request(
          `/invocations/${id}`,
          "DELETE",
          undefined,
          AbortSignal.timeout(5000),
        ).catch(() => {});
    }
  }
}
