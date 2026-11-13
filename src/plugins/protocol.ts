import { z } from "zod";
import { assertJson, limits, PluginError } from "./contract.ts";
import { localName } from "./manifest.ts";

export const protocolVersion = 1;
export const rpcId = z.string().regex(/^[a-z][A-Za-z0-9_-]{0,63}$/);
export const brokerRequestSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("github.repository.get"),
      params: z
        .object({ repositoryId: z.number().int().positive().safe() })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("http.request"),
      params: z
        .object({
          connection: localName,
          path: z.string().min(1).max(512),
          query: z.record(z.string().max(64), z.string().max(2048)).optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type BrokerRequest = z.infer<typeof brokerRequestSchema>;
export const initializeParams = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    manifest: z.json(),
    invocation: z
      .object({ id: z.string().uuid(), deadline: z.string().datetime() })
      .strict(),
    settings: z.json(),
    bundle: z
      .object({
        size: z.number().int().positive().max(limits.bundle),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();
export const invocationParams = z
  .object({ tool: localName, arguments: z.json() })
  .strict();
export const requestSchema = z.discriminatedUnion("method", [
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: rpcId,
      method: z.literal("initialize"),
      params: initializeParams,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: rpcId,
      method: z.literal("tool.invoke"),
      params: invocationParams,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: rpcId,
      method: z.literal("broker.request"),
      params: brokerRequestSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: rpcId,
      method: z.literal("diagnostic.emit"),
      params: z
        .object({ code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) })
        .strict(),
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: rpcId,
      method: z.literal("cancel"),
      params: z.object({}).strict(),
    })
    .strict(),
]);
export const errorCodes = [
  "plugin_manifest_invalid",
  "plugin_input_invalid",
  "plugin_result_invalid",
  "plugin_settings_invalid",
  "plugin_package_invalid",
  "plugin_protocol_invalid",
  "plugin_permission_denied",
  "plugin_connection_required",
  "plugin_execution_failed",
  "plugin_unavailable",
  "plugin_timeout",
  "plugin_cancelled",
  "plugin_outcome_unknown",
] as const;
export const responseSchema = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: rpcId, result: z.json() }).strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: rpcId,
      error: z.object({ code: z.enum(errorCodes) }).strict(),
    })
    .strict(),
]);
export type RpcRequest = z.infer<typeof requestSchema>;
export type RpcResponse = z.infer<typeof responseSchema>;
export const notificationSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.literal("package.chunk"),
    params: z
      .object({
        offset: z.number().int().min(0).max(limits.bundle),
        data: z
          .string()
          .regex(/^[A-Za-z0-9+/]+={0,2}$/)
          .max(90000),
        final: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type RpcFrame =
  | RpcRequest
  | RpcResponse
  | z.infer<typeof notificationSchema>;

export function parseFrame(value: unknown): RpcFrame {
  try {
    assertJson(value, limits.frame);
    return z
      .union([requestSchema, responseSchema, notificationSchema])
      .parse(value);
  } catch {
    throw new PluginError("plugin_protocol_invalid");
  }
}

/** Newline framing is bounded before JSON parsing; raw subprocess output is discarded. */
export class FrameReader {
  private buffer = Buffer.alloc(0);
  feed(chunk: Uint8Array): RpcFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: RpcFrame[] = [];
    let end = this.buffer.indexOf(10);
    while (end >= 0) {
      if (end === 0 || end > limits.frame)
        throw new PluginError("plugin_protocol_invalid");
      let value: unknown;
      try {
        value = JSON.parse(this.buffer.subarray(0, end).toString("utf8"));
      } catch {
        throw new PluginError("plugin_protocol_invalid");
      }
      frames.push(parseFrame(value));
      this.buffer = this.buffer.subarray(end + 1);
      end = this.buffer.indexOf(10);
    }
    if (this.buffer.length > limits.frame)
      throw new PluginError("plugin_protocol_invalid");
    return frames;
  }
  finish() {
    if (this.buffer.length) throw new PluginError("plugin_protocol_invalid");
  }
}

/** Host-owned protocol state. No message can replace the invocation's identity. */
export class HostSession {
  private state: "initializing" | "ready" | "running" | "done" = "initializing";
  private seen = new Set<string>();
  private brokerCalls = 0;
  private notifications = 0;
  accept(frame: RpcFrame): "initialized" | "result" | "broker" | "diagnostic" {
    if (!("id" in frame) || this.state === "done" || this.seen.has(frame.id))
      throw new PluginError("plugin_protocol_invalid");
    this.seen.add(frame.id);
    if (!("method" in frame)) {
      if (
        frame.id === "initialize" &&
        this.state === "initializing" &&
        "result" in frame &&
        frame.result === protocolVersion
      ) {
        this.state = "ready";
        return "initialized";
      }
      if (frame.id === "invoke" && this.state === "running") {
        this.state = "done";
        return "result";
      }
    } else if (this.state === "running" && /^p[0-9]+$/.test(frame.id)) {
      if (
        frame.method === "broker.request" &&
        ++this.brokerCalls <= limits.brokerRequests
      )
        return "broker";
      if (frame.method === "diagnostic.emit" && ++this.notifications <= 32)
        return "diagnostic";
    }
    throw new PluginError("plugin_protocol_invalid");
  }
  invoke() {
    if (this.state !== "ready")
      throw new PluginError("plugin_protocol_invalid");
    this.state = "running";
  }
  close() {
    this.state = "done";
  }
}
