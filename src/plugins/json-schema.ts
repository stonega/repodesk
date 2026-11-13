import { z } from "zod";
import { type Json, PluginError } from "./contract.ts";

export interface DataSchema {
  type:
    | "object"
    | "array"
    | "string"
    | "integer"
    | "number"
    | "boolean"
    | "null";
  title?: string;
  description?: string;
  properties?: Record<string, DataSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: DataSchema;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  enum?: Json[];
  const?: Json;
  default?: Json;
}
export const dataSchema: z.ZodType<DataSchema> = z.lazy(() =>
  z
    .object({
      type: z.enum([
        "object",
        "array",
        "string",
        "integer",
        "number",
        "boolean",
        "null",
      ]),
      title: z.string().max(100).optional(),
      description: z.string().max(1024).optional(),
      properties: z.record(z.string().max(100), dataSchema).optional(),
      required: z.array(z.string().max(100)).max(64).optional(),
      additionalProperties: z.literal(false).optional(),
      items: dataSchema.optional(),
      minLength: z.number().int().min(0).max(64000).optional(),
      maxLength: z.number().int().min(0).max(64000).optional(),
      minItems: z.number().int().min(0).max(1000).optional(),
      maxItems: z.number().int().min(0).max(1000).optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      enum: z.array(z.json()).min(1).max(32).optional(),
      const: z.json().optional(),
      default: z.json().optional(),
    })
    .strict(),
);

const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const left = Object.entries(a);
    return (
      left.length === Object.keys(b).length &&
      left.every(([k, v]) => Object.hasOwn(b, k) && same(v, Reflect.get(b, k)))
    );
  }
  return false;
};

/** Deliberately small, noncoercing JSON Schema profile, shared with type generation. */
export function matches(schema: DataSchema, value: unknown): boolean {
  if (Object.hasOwn(schema, "const") && !same(value, schema.const))
    return false;
  if (schema.enum && !schema.enum.some((v) => same(value, v))) return false;
  switch (schema.type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string": {
      if (typeof value !== "string") return false;
      const length = [...value].length;
      return (
        length >= (schema.minLength ?? 0) &&
        length <= (schema.maxLength ?? 64000)
      );
    }
    case "integer":
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (schema.type !== "integer" || Number.isSafeInteger(value)) &&
        value >= (schema.minimum ?? -Infinity) &&
        value <= (schema.maximum ?? Infinity)
      );
    case "array":
      return (
        Array.isArray(value) &&
        value.length >= (schema.minItems ?? 0) &&
        value.length <= (schema.maxItems ?? 1000) &&
        !!schema.items &&
        value.every((v) => schema.items && matches(schema.items, v))
      );
    case "object":
      return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (schema.required ?? []).every((k) => Object.hasOwn(value, k)) &&
        Object.entries(value).every(([k, v]) => {
          const child = Object.hasOwn(schema.properties ?? {}, k)
            ? schema.properties?.[k]
            : undefined;
          return !!child && matches(child, v);
        })
      );
  }
}

export function validateSchema(root: DataSchema) {
  let count = 0;
  const visit = (schema: DataSchema, depth: number) => {
    if (++count > 256 || depth > 8)
      throw new PluginError("plugin_manifest_invalid");
    const allowed = new Set([
      "type",
      "title",
      "description",
      "enum",
      "const",
      "default",
    ]);
    const keys: Record<DataSchema["type"], string[]> = {
      object: ["properties", "required", "additionalProperties"],
      array: ["items", "minItems", "maxItems"],
      string: ["minLength", "maxLength"],
      number: ["minimum", "maximum"],
      integer: ["minimum", "maximum"],
      boolean: [],
      null: [],
    };
    for (const key of keys[schema.type]) allowed.add(key);
    if (Object.keys(schema).some((k) => !allowed.has(k)))
      throw new PluginError("plugin_manifest_invalid");
    if (schema.type === "object") {
      const properties = schema.properties ?? {};
      if (
        schema.additionalProperties !== false ||
        Object.keys(properties).length > 64 ||
        new Set(schema.required).size !== (schema.required?.length ?? 0) ||
        (schema.required ?? []).some((k) => !Object.hasOwn(properties, k)) ||
        Object.keys(properties).some((k) =>
          ["__proto__", "constructor", "prototype"].includes(k),
        )
      )
        throw new PluginError("plugin_manifest_invalid");
      for (const child of Object.values(properties)) visit(child, depth + 1);
    }
    if (schema.type === "array") {
      if (!schema.items || schema.maxItems === undefined)
        throw new PluginError("plugin_manifest_invalid");
      visit(schema.items, depth + 1);
    }
    if (
      (schema.minLength ?? 0) > (schema.maxLength ?? 64000) ||
      (schema.minItems ?? 0) > (schema.maxItems ?? 1000) ||
      (schema.minimum ?? -Infinity) > (schema.maximum ?? Infinity)
    )
      throw new PluginError("plugin_manifest_invalid");
    // Enum/const values must independently satisfy the underlying type and constraints.
    const plain = { ...schema };
    delete plain.enum;
    delete plain.const;
    if (
      schema.enum?.some(
        (v, i, all) =>
          !matches(plain, v) || all.slice(0, i).some((a) => same(a, v)),
      ) ||
      (Object.hasOwn(schema, "const") && !matches(plain, schema.const)) ||
      (Object.hasOwn(schema, "default") && !matches(schema, schema.default))
    )
      throw new PluginError("plugin_manifest_invalid");
  };
  visit(root, 0);
}

export function schemaType(schema: DataSchema): string {
  if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  switch (schema.type) {
    case "object":
      return `{ ${Object.entries(schema.properties ?? {})
        .map(
          ([k, v]) =>
            `${JSON.stringify(k)}${schema.required?.includes(k) ? "" : "?"}: ${schemaType(v)}`,
        )
        .join("; ")} }`;
    case "array":
      return `(${schemaType(schema.items as DataSchema)})[]`;
    case "integer":
      return "number";
    default:
      return schema.type;
  }
}

export function settingsDefaults(schema: DataSchema, value: unknown): unknown {
  if (
    schema.type !== "object" ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    return value;
  const result = { ...value };
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (!Object.hasOwn(result, key) && Object.hasOwn(child, "default"))
      Object.defineProperty(result, key, {
        value: structuredClone(child.default),
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  return result;
}
