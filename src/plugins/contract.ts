import type { Json } from "../../sdk/plugin/index.ts";

export type {
  Json,
  JsonObject,
  PluginDefinition,
  RepositorySummary,
  ToolContext,
  ToolContracts,
  ToolResult,
} from "../../sdk/plugin/index.ts";
export type Capability = "github.metadata.read" | "http.read";
export type PluginErrorCode =
  | "plugin_manifest_invalid"
  | "plugin_input_invalid"
  | "plugin_result_invalid"
  | "plugin_settings_invalid"
  | "plugin_package_invalid"
  | "plugin_protocol_invalid"
  | "plugin_permission_denied"
  | "plugin_connection_required"
  | "plugin_execution_failed"
  | "plugin_unavailable"
  | "plugin_timeout"
  | "plugin_cancelled"
  | "plugin_outcome_unknown";

export class PluginError extends Error {
  constructor(readonly code: PluginErrorCode) {
    super(code);
  }
}
export const limits = {
  manifest: 65536,
  input: 65536,
  result: 262144,
  frame: 262144,
  bundle: 5 * 1024 * 1024,
  archive: 10 * 1024 * 1024,
  package: 32 * 1024 * 1024,
  files: 512,
  brokerRequests: 10,
  deadlineMs: 30000,
} as const;

/** Reject non-JSON values before serialization, including cycles and prototypes. */
export function assertJson(
  value: unknown,
  maxBytes: number,
): asserts value is Json {
  const pending: { value: unknown; depth: number; exit?: boolean }[] = [
    { value, depth: 0 },
  ];
  const seen = new Set<object>();
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (item?.exit && item.value && typeof item.value === "object") {
      seen.delete(item.value);
      continue;
    }
    if (!item || ++nodes > 20000 || item.depth > 24)
      throw new PluginError("plugin_input_invalid");
    const data = item.value;
    if (data === null || typeof data === "boolean" || typeof data === "string")
      continue;
    if (typeof data === "number" && Number.isFinite(data)) continue;
    if (
      typeof data !== "object" ||
      seen.has(data) ||
      (!Array.isArray(data) &&
        Object.getPrototypeOf(data) !== Object.prototype &&
        Object.getPrototypeOf(data) !== null)
    )
      throw new PluginError("plugin_input_invalid");
    seen.add(data);
    pending.push({ value: data, depth: item.depth, exit: true });
    if (
      Object.getOwnPropertySymbols(data).length ||
      Object.values(Object.getOwnPropertyDescriptors(data)).some(
        (descriptor) => !("value" in descriptor),
      )
    )
      throw new PluginError("plugin_input_invalid");
    if (
      Array.isArray(data) &&
      (Object.keys(data).length !== data.length ||
        Object.keys(data).some((key, index) => key !== String(index)))
    )
      throw new PluginError("plugin_input_invalid");
    for (const child of Object.values(data))
      pending.push({ value: child, depth: item.depth + 1 });
  }
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes)
    throw new PluginError("plugin_input_invalid");
}
