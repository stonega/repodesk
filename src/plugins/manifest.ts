import { z } from "zod";
import { assertJson, limits, PluginError } from "./contract.ts";
import { dataSchema, schemaType, validateSchema } from "./json-schema.ts";

export const capabilitySchema = z.enum(["github.metadata.read", "http.read"]);
export const localName = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const pathSchema = z.string().min(1).max(512);
const originSchema = z.string().max(2048);
export const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    name: z.string().min(1).max(100),
    description: z.string().min(1).max(1024),
    version: z
      .string()
      .regex(
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
      ),
    apiVersion: z.literal("1"),
    license: z.string().min(1).max(200),
    repository: z
      .string()
      .regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .max(256),
    publisher: z.object({ name: z.string().min(1).max(100) }).strict(),
    runtime: z
      .object({ type: z.literal("node-sandbox"), entry: pathSchema })
      .strict(),
    capabilities: z.array(capabilitySchema).max(2),
    settingsSchema: dataSchema,
    settingsUi: z
      .record(
        z.string(),
        z
          .object({
            label: z.string().max(100),
            help: z.string().max(1024).optional(),
            order: z.number().int().min(0).max(64).optional(),
          })
          .strict(),
      )
      .optional(),
    connections: z
      .array(
        z
          .object({
            id: localName,
            name: z.string().min(1).max(100),
            scope: z.enum(["member", "workspace"]),
            auth: z.object({ type: z.enum(["none", "bearer"]) }).strict(),
            requests: z
              .array(
                z
                  .object({
                    origin: originSchema,
                    paths: z.array(pathSchema).min(1).max(32),
                    queryKeys: z
                      .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/))
                      .max(32),
                  })
                  .strict(),
              )
              .min(1)
              .max(8),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    diagnosticCodes: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/))
      .max(32)
      .optional(),
    tools: z
      .array(
        z
          .object({
            name: localName,
            title: z.string().min(1).max(100),
            description: z.string().min(1).max(1024),
            effect: z.enum(["compute", "read"]),
            capabilities: z.array(capabilitySchema).max(2),
            inputSchema: dataSchema,
            outputSchema: dataSchema,
          })
          .strict(),
      )
      .min(1)
      .max(32),
    skills: z.array(z.object({ path: pathSchema }).strict()).max(16),
    metadata: z.record(z.string().max(100), z.string().max(1024)).optional(),
  })
  .strict();
export type PluginManifest = z.infer<typeof manifestSchema>;

export function safeResourcePath(path: string): boolean {
  return (
    /^[A-Za-z0-9._-][A-Za-z0-9._/-]{0,511}$/.test(path) &&
    !path.split("/").some((p) => !p || p === "." || p === "..") &&
    !path.includes("\\")
  );
}
const unique = (values: readonly unknown[]) =>
  new Set(values).size === values.length;

/** Validates data only; never imports or executes the entrypoint. */
export function parseManifest(value: unknown): PluginManifest {
  try {
    assertJson(value, limits.manifest);
    const manifest = manifestSchema.parse(value);
    if (
      !safeResourcePath(manifest.runtime.entry) ||
      !manifest.runtime.entry.endsWith(".mjs") ||
      !unique(manifest.tools.map((t) => t.name)) ||
      !unique(manifest.capabilities) ||
      !unique(manifest.connections?.map((c) => c.id) ?? []) ||
      !unique(manifest.skills.map((s) => s.path)) ||
      !unique(manifest.diagnosticCodes ?? []) ||
      manifest.settingsSchema.type !== "object" ||
      Object.keys(manifest.metadata ?? {}).length > 32
    )
      throw new PluginError("plugin_manifest_invalid");
    validateSchema(manifest.settingsSchema);
    const scalar = new Set(["string", "integer", "number", "boolean"]);
    for (const field of Object.values(
      manifest.settingsSchema.properties ?? {},
    )) {
      if (
        !scalar.has(field.type) &&
        !(field.type === "array" && field.items && scalar.has(field.items.type))
      )
        throw new PluginError("plugin_manifest_invalid");
    }
    if (
      manifest.skills.length &&
      (manifest.tools.length > 31 ||
        manifest.tools.some((t) => t.name === "load_guide"))
    )
      throw new PluginError("plugin_manifest_invalid");
    for (const field of Object.keys(manifest.settingsUi ?? {}))
      if (!Object.hasOwn(manifest.settingsSchema.properties ?? {}, field))
        throw new PluginError("plugin_manifest_invalid");
    for (const tool of manifest.tools) {
      if (
        tool.inputSchema.type !== "object" ||
        tool.outputSchema.type !== "object" ||
        !unique(tool.capabilities) ||
        tool.capabilities.some((c) => !manifest.capabilities.includes(c)) ||
        (tool.effect === "compute" && tool.capabilities.length > 0)
      )
        throw new PluginError("plugin_manifest_invalid");
      validateSchema(tool.inputSchema);
      validateSchema(tool.outputSchema);
    }
    for (const skill of manifest.skills)
      if (!safeResourcePath(skill.path) || !skill.path.endsWith("/SKILL.md"))
        throw new PluginError("plugin_manifest_invalid");
    for (const connection of manifest.connections ?? []) {
      if (!manifest.capabilities.includes("http.read"))
        throw new PluginError("plugin_manifest_invalid");
      for (const request of connection.requests) {
        const url = new URL(request.origin);
        if (
          url.protocol !== "https:" ||
          url.origin !== request.origin ||
          url.username ||
          url.password ||
          !unique(request.paths) ||
          !unique(request.queryKeys)
        )
          throw new PluginError("plugin_manifest_invalid");
        for (const path of request.paths)
          if (
            !path.startsWith("/") ||
            path.includes("%") ||
            !safeResourcePath(path.slice(1))
          )
            throw new PluginError("plugin_manifest_invalid");
      }
    }
    return manifest;
  } catch {
    throw new PluginError("plugin_manifest_invalid");
  }
}

export function generateContract(manifest: PluginManifest): string {
  const tools = manifest.tools
    .map(
      (tool) =>
        `${JSON.stringify(tool.name)}: { input: ${schemaType(tool.inputSchema)}; output: ${schemaType(tool.outputSchema)} }`,
    )
    .join(";\n  ");
  return `// Generated from repodesk.plugin.json. Do not edit.\nexport type Settings = ${schemaType(manifest.settingsSchema)};\nexport type Contract = {\n  ${tools}\n};\n`;
}
