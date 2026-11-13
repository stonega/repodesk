/** Runs only in the restricted, credential-free plugin image. */

import { createHash } from "node:crypto";
import { type Json, type JsonObject, PluginError } from "./contract.ts";
import {
  createToolContext,
  validateDefinition,
  validateInput,
  validateResult,
  validateSettings,
} from "./invocation.ts";
import { type PluginManifest, parseManifest } from "./manifest.ts";
import {
  FrameReader,
  protocolVersion,
  type RpcRequest,
  type RpcResponse,
} from "./protocol.ts";

const reader = new FrameReader();
const controller = new AbortController();
let state: "new" | "receiving" | "ready" | "running" | "done" = "new";
let manifest: PluginManifest;
let settings: JsonObject;
let invocation: { id: string; deadline: string };
let sequence = 0;
let bundleSize = 0;
let bundleHash = "";
let receivedBytes = 0;
let bundleUrl = "";
const chunks: Buffer[] = [];
const pending = new Map<
  string,
  { resolve: (value: Json) => void; reject: (error: Error) => void }
>();
const send = (value: RpcRequest | RpcResponse) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
function request(
  method: "broker.request" | "diagnostic.emit",
  params: RpcRequest["params"],
): Promise<Json> {
  controller.signal.throwIfAborted();
  const id = `p${++sequence}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params } as RpcRequest);
  });
}
async function invoke(frame: Extract<RpcRequest, { method: "tool.invoke" }>) {
  try {
    const args = validateInput(
      manifest,
      frame.params.tool,
      frame.params.arguments,
    );
    const entry = bundleUrl;
    const definition = validateDefinition(
      manifest,
      (await import(entry)).default,
    );
    const handler = definition.tools[frame.params.tool];
    if (!handler) throw new PluginError("plugin_package_invalid");
    const context = createToolContext({
      manifest,
      tool: frame.params.tool,
      settings,
      invocation,
      signal: controller.signal,
      grants: manifest.capabilities,
      guard: async () => {
        controller.signal.throwIfAborted();
      },
      broker: (params) => request("broker.request", params),
      diagnostic: (code) => {
        void request("diagnostic.emit", { code }).catch(() => {});
      },
    });
    const result = validateResult(
      manifest,
      frame.params.tool,
      await handler(args, context),
    );
    send({ jsonrpc: "2.0", id: "invoke", result: result as unknown as Json });
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: "invoke",
      error: {
        code: controller.signal.aborted
          ? "plugin_cancelled"
          : error instanceof PluginError
            ? error.code
            : "plugin_execution_failed",
      },
    });
  } finally {
    state = "done";
  }
}
try {
  for await (const chunk of process.stdin) {
    for (const frame of reader.feed(chunk)) {
      if (
        "method" in frame &&
        frame.method === "package.chunk" &&
        state === "receiving"
      ) {
        if (frame.params.offset !== receivedBytes)
          throw new PluginError("plugin_protocol_invalid");
        const bytes = Buffer.from(frame.params.data, "base64");
        if (
          bytes.toString("base64") !== frame.params.data ||
          !bytes.length ||
          bytes.length > 65536 ||
          receivedBytes + bytes.length > bundleSize
        )
          throw new PluginError("plugin_protocol_invalid");
        receivedBytes += bytes.length;
        chunks.push(bytes);
        if (frame.params.final) {
          const bundle = Buffer.concat(chunks);
          if (
            receivedBytes !== bundleSize ||
            createHash("sha256").update(bundle).digest("hex") !== bundleHash
          )
            throw new PluginError("plugin_package_invalid");
          bundleUrl = `data:text/javascript;base64,${bundle.toString("base64")}`;
          chunks.length = 0;
          state = "ready";
          send({ jsonrpc: "2.0", id: "initialize", result: protocolVersion });
        }
      } else if (!("method" in frame)) {
        const waiter = pending.get(frame.id);
        if (!waiter || state !== "running")
          throw new PluginError("plugin_protocol_invalid");
        pending.delete(frame.id);
        if ("error" in frame) waiter.reject(new PluginError(frame.error.code));
        else waiter.resolve(frame.result);
      } else if (
        frame.method === "initialize" &&
        state === "new" &&
        frame.id === "initialize"
      ) {
        manifest = parseManifest(frame.params.manifest);
        settings = validateSettings(manifest, frame.params.settings);
        invocation = frame.params.invocation;
        if (Date.parse(invocation.deadline) <= Date.now())
          throw new PluginError("plugin_timeout");
        bundleSize = frame.params.bundle.size;
        bundleHash = frame.params.bundle.sha256;
        state = "receiving";
      } else if (
        frame.method === "tool.invoke" &&
        state === "ready" &&
        frame.id === "invoke"
      ) {
        state = "running";
        void invoke(frame);
      } else if (frame.method === "cancel") {
        controller.abort();
        for (const waiter of pending.values())
          waiter.reject(new PluginError("plugin_cancelled"));
        pending.clear();
      } else throw new PluginError("plugin_protocol_invalid");
    }
  }
} catch {
  // Raw author output/errors never leave the sandbox through diagnostics.
  process.exitCode = 1;
} finally {
  controller.abort();
}
