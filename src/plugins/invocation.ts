import { z } from "zod";
import {
  assertJson,
  type Capability,
  type Json,
  type JsonObject,
  limits,
  PluginError,
  type ToolContext,
  type ToolResult,
} from "./contract.ts";
import { matches, settingsDefaults } from "./json-schema.ts";
import type { PluginManifest } from "./manifest.ts";
import { type BrokerRequest, brokerRequestSchema } from "./protocol.ts";

export type RuntimeDefinition = {
  tools: Record<
    string,
    (input: JsonObject, context: ToolContext<JsonObject>) => Promise<ToolResult>
  >;
};
export type Broker = (
  request: BrokerRequest,
  signal: AbortSignal,
) => Promise<Json>;
const repositorySummary = z
  .object({
    url: z.string().url().max(2048),
    stars: z.number().int().nonnegative().safe(),
    forks: z.number().int().nonnegative().safe(),
    subscribers: z.number().int().nonnegative().safe(),
    fetchedAt: z.string().datetime(),
  })
  .strict();
const resultSchema = z
  .object({
    content: z
      .array(
        z
          .object({
            type: z.literal("text"),
            text: z.string().max(limits.result),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    structuredContent: z.record(z.string(), z.json()),
  })
  .strict();

export function toolFor(manifest: PluginManifest, name: string) {
  const tool = manifest.tools.find((t) => t.name === name);
  if (!tool) throw new PluginError("plugin_permission_denied");
  return tool;
}
export function validateInput(
  manifest: PluginManifest,
  tool: string,
  value: unknown,
) {
  assertJson(value, limits.input);
  if (!matches(toolFor(manifest, tool).inputSchema, value))
    throw new PluginError("plugin_input_invalid");
  return value as JsonObject;
}
export function validateSettings(
  manifest: PluginManifest,
  value: unknown,
): JsonObject {
  try {
    assertJson(value, limits.input);
    const result = settingsDefaults(manifest.settingsSchema, value);
    if (!matches(manifest.settingsSchema, result))
      throw new PluginError("plugin_settings_invalid");
    return result as JsonObject;
  } catch {
    throw new PluginError("plugin_settings_invalid");
  }
}
export function validateResult(
  manifest: PluginManifest,
  tool: string,
  value: unknown,
): ToolResult {
  try {
    assertJson(value, limits.result);
    const result = resultSchema.parse(value);
    if (
      !matches(toolFor(manifest, tool).outputSchema, result.structuredContent)
    )
      throw new PluginError("plugin_result_invalid");
    return result;
  } catch {
    throw new PluginError("plugin_result_invalid");
  }
}
export function validateDefinition(
  manifest: PluginManifest,
  value: unknown,
): RuntimeDefinition {
  const tools =
    value && typeof value === "object" && Object.hasOwn(value, "tools")
      ? Reflect.get(value, "tools")
      : undefined;
  if (
    !tools ||
    typeof tools !== "object" ||
    Array.isArray(tools) ||
    Object.keys(value as object).some((key) => key !== "tools") ||
    Object.keys(tools).length !== manifest.tools.length ||
    manifest.tools.some(
      (t) =>
        !Object.hasOwn(tools, t.name) || typeof tools[t.name] !== "function",
    )
  )
    throw new PluginError("plugin_package_invalid");
  return value as RuntimeDefinition;
}

export function authorizeBroker(
  manifest: PluginManifest,
  tool: string,
  grants: readonly Capability[],
  value: unknown,
): BrokerRequest {
  const parsed = brokerRequestSchema.safeParse(value);
  if (!parsed.success) throw new PluginError("plugin_protocol_invalid");
  const capability: Capability =
    parsed.data.method === "github.repository.get"
      ? "github.metadata.read"
      : "http.read";
  if (
    !toolFor(manifest, tool).capabilities.includes(capability) ||
    !grants.includes(capability)
  )
    throw new PluginError("plugin_permission_denied");
  if (parsed.data.method === "http.request") {
    const request = parsed.data.params;
    const connection = manifest.connections?.find(
      (c) => c.id === request.connection,
    );
    if (
      !connection?.requests.some(
        (rule) =>
          rule.paths.includes(request.path) &&
          Object.keys(request.query ?? {}).every((k) =>
            rule.queryKeys.includes(k),
          ),
      )
    )
      throw new PluginError("plugin_permission_denied");
  }
  return parsed.data;
}

export function createToolContext(options: {
  manifest: PluginManifest;
  tool: string;
  settings: JsonObject;
  invocation: { id: string; deadline: string };
  signal: AbortSignal;
  grants: readonly Capability[];
  guard: () => Promise<void>;
  broker: Broker;
  diagnostic?: (code: string) => void;
}): ToolContext<JsonObject> {
  let calls = 0;
  const request = async (value: BrokerRequest) => {
    options.signal.throwIfAborted();
    if (++calls > limits.brokerRequests)
      throw new PluginError("plugin_permission_denied");
    const checked = authorizeBroker(
      options.manifest,
      options.tool,
      options.grants,
      value,
    );
    await options.guard();
    const result = await options.broker(checked, options.signal);
    options.signal.throwIfAborted();
    await options.guard();
    assertJson(result, limits.result);
    return result;
  };
  return Object.freeze({
    settings: Object.freeze(structuredClone(options.settings)),
    invocation: Object.freeze({ ...options.invocation }),
    signal: options.signal,
    github: Object.freeze({
      async getRepository(input: { repositoryId: number }) {
        const value = await request({
          method: "github.repository.get",
          params: input,
        });
        const result = repositorySummary.safeParse(value);
        if (!result.success) throw new PluginError("plugin_result_invalid");
        return result.data;
      },
    }),
    http: Object.freeze({
      async request(
        connection: string,
        input: { path: string; query?: Record<string, string> },
      ) {
        const value = await request({
          method: "http.request",
          params: { connection, ...input },
        });
        const result = z
          .object({
            status: z.number().int().min(100).max(599),
            data: z.json(),
          })
          .strict()
          .safeParse(value);
        if (!result.success) throw new PluginError("plugin_result_invalid");
        return result.data;
      },
    }),
    diagnostics: Object.freeze({
      emit(code: string) {
        if (!options.manifest.diagnosticCodes?.includes(code))
          throw new PluginError("plugin_permission_denied");
        options.diagnostic?.(code);
      },
    }),
  });
}
