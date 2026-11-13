import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  assertJson,
  type Json,
  PluginError,
} from "../../src/plugins/contract.ts";
import {
  authorizeBroker,
  createToolContext,
  validateDefinition,
  validateInput,
  validateResult,
  validateSettings,
} from "../../src/plugins/invocation.ts";
import { matches, schemaType } from "../../src/plugins/json-schema.ts";
import {
  loadLocalPackage,
  packageDigest,
  validatePackageFiles,
} from "../../src/plugins/local-package.ts";
import {
  generateContract,
  parseManifest,
  safeResourcePath,
} from "../../src/plugins/manifest.ts";

const raw = JSON.parse(
  await readFile("examples/plugins/word-count/repodesk.plugin.json", "utf8"),
);
const githubRaw = JSON.parse(
  await readFile(
    "examples/plugins/repository-insights/repodesk.plugin.json",
    "utf8",
  ),
);
const sample = () => structuredClone(raw);
const github = () => parseManifest(structuredClone(githubRaw));

test("valid manifests and generated types share one schema authority", async () => {
  const manifest = parseManifest(sample());
  expect(generateContract(manifest)).toContain('"text": string');
  expect(generateContract(manifest)).toBe(
    await readFile(
      "examples/plugins/word-count/src/generated/contract.ts",
      "utf8",
    ),
  );
  expect(schemaType({ type: "integer", enum: [1, 2] })).toBe("1 | 2");
});

test.each([
  (m: typeof raw) => {
    m.unknown = true;
  },
  (m: typeof raw) => {
    m.apiVersion = "2";
  },
  (m: typeof raw) => {
    m.capabilities = ["shell"];
  },
  (m: typeof raw) => {
    m.tools.push(m.tools[0]);
  },
  (m: typeof raw) => {
    m.tools[0].capabilities = ["github.metadata.read"];
  },
  (m: typeof raw) => {
    m.tools[0].inputSchema.$ref = "https://invalid.test/schema";
  },
  (m: typeof raw) => {
    m.tools[0].inputSchema.additionalProperties = true;
  },
  (m: typeof raw) => {
    m.tools[0].inputSchema.required = ["missing"];
  },
  (m: typeof raw) => {
    m.tools[0].inputSchema.properties.text.format = "secret";
  },
  (m: typeof raw) => {
    m.tools[0].inputSchema.properties.text.minimum = 2;
  },
  (m: typeof raw) => {
    m.runtime.entry = "../outside.mjs";
  },
  (m: typeof raw) => {
    m.runtime.entry = "/tmp/plugin.mjs";
  },
  (m: typeof raw) => {
    m.runtime.entry = "dist/plugin.ts";
  },
  (m: typeof raw) => {
    m.settingsUi = { unknown: { label: "Unknown" } };
  },
  (m: typeof raw) => {
    m.tools[0].inputSchema.properties.text.enum = [1];
  },
  (m: typeof raw) => {
    m.tools[0].inputSchema.properties.text.default = 1;
  },
  (m: typeof raw) => {
    m.tools[0].inputSchema.properties.text.maxLength = 1000000;
  },
])("malformed or unsupported manifest fails closed %#", (mutate) => {
  const value = sample();
  mutate(value);
  expect(() => parseManifest(value)).toThrow("plugin_manifest_invalid");
});

test("schemas do not coerce values or accept extra properties", () => {
  const manifest = parseManifest(sample());
  expect(validateInput(manifest, "count_words", { text: "one" })).toEqual({
    text: "one",
  });
  for (const value of [{ text: 2 }, { text: "one", actor: "other" }, {}, null])
    expect(() => validateInput(manifest, "count_words", value)).toThrow(
      "plugin_input_invalid",
    );
  expect(matches({ type: "integer" }, 1.1)).toBe(false);
  expect(matches({ type: "integer" }, Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  expect(matches({ type: "string", maxLength: 1 }, "😀")).toBe(true);
});

test("settings defaults validate and never mutate source settings", () => {
  const value = sample();
  value.settingsSchema = {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 10, default: 3 },
    },
    required: ["limit"],
    additionalProperties: false,
  };
  const manifest = parseManifest(value);
  const settings = {};
  expect(validateSettings(manifest, settings)).toEqual({ limit: 3 });
  expect(settings).toEqual({});
  expect(() => validateSettings(manifest, { limit: 0 })).toThrow(
    "plugin_settings_invalid",
  );
});

test("non-JSON, excessive depth, cycles and oversized values are rejected", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [
    NaN,
    Infinity,
    undefined,
    () => {},
    new Date(),
    cycle,
    { x: BigInt(1) },
  ])
    expect(() => assertJson(value, 1000)).toThrow();
  expect(() => assertJson("a".repeat(1001), 1000)).toThrow();
  let nested: unknown = {};
  for (let n = 0; n < 30; n++) nested = { nested };
  expect(() => parseManifest(nested)).toThrow("plugin_manifest_invalid");
});

test("handler set and result must exactly match the reviewed manifest", () => {
  const manifest = parseManifest(sample());
  const fn = async () => ({
    content: [{ type: "text" as const, text: "1" }],
    structuredContent: { count: 1 },
  });
  expect(
    validateDefinition(manifest, { tools: { count_words: fn } }).tools
      .count_words,
  ).toBe(fn);
  for (const value of [
    { tools: {} },
    { tools: { count_words: fn, extra: fn } },
    { tools: { count_words: "x" } },
    { tools: { count_words: fn }, hooks: {} },
  ])
    expect(() => validateDefinition(manifest, value)).toThrow(
      "plugin_package_invalid",
    );
  const result = {
    content: [{ type: "text" as const, text: "1" }],
    structuredContent: { count: 1 },
  };
  expect(validateResult(manifest, "count_words", result)).toEqual(result);
  for (const invalid of [
    { ...result, structuredContent: { count: -1 } },
    { ...result, content: [{ type: "image", text: "x" }] },
    { ...result, secret: "x" },
    { content: [], structuredContent: { count: 1 } },
  ])
    expect(() => validateResult(manifest, "count_words", invalid)).toThrow(
      "plugin_result_invalid",
    );
});

test("tool capability ceiling and host grants are both necessary", () => {
  const manifest = github();
  const request = {
    method: "github.repository.get" as const,
    params: { repositoryId: 123 },
  };
  expect(() =>
    authorizeBroker(manifest, "repository_summary", [], request),
  ).toThrow("plugin_permission_denied");
  expect(
    authorizeBroker(
      manifest,
      "repository_summary",
      ["github.metadata.read"],
      request,
    ),
  ).toEqual(request);
  expect(() =>
    authorizeBroker(manifest, "repository_summary", ["github.metadata.read"], {
      ...request,
      params: { repositoryId: 123, workspaceId: "other" },
    }),
  ).toThrow("plugin_protocol_invalid");
  expect(() =>
    authorizeBroker(
      parseManifest(sample()),
      "count_words",
      ["github.metadata.read"],
      request,
    ),
  ).toThrow("plugin_permission_denied");
});

test("broker rechecks current authorization and honors cancellation and quotas", async () => {
  let guards = 0;
  let calls = 0;
  const controller = new AbortController();
  const manifest = github();
  const context = createToolContext({
    manifest,
    tool: "repository_summary",
    settings: {},
    signal: controller.signal,
    invocation: { id: "fixture", deadline: new Date().toISOString() },
    grants: ["github.metadata.read"],
    guard: async () => {
      guards++;
    },
    broker: async () => {
      calls++;
      return {
        url: "https://github.com/example/repository",
        stars: 1,
        forks: 0,
        subscribers: 0,
        fetchedAt: new Date().toISOString(),
      };
    },
  });
  for (let n = 0; n < 10; n++)
    await context.github.getRepository({ repositoryId: 123 });
  expect(guards).toBe(20);
  expect(calls).toBe(10);
  await expect(
    context.github.getRepository({ repositoryId: 123 }),
  ).rejects.toThrow("plugin_permission_denied");
  controller.abort();
  await expect(
    context.github.getRepository({ repositoryId: 123 }),
  ).rejects.toThrow();
  expect(calls).toBe(10);
});

test("revocation after broker dispatch suppresses its returned data", async () => {
  let allowed = true;
  const context = createToolContext({
    manifest: github(),
    tool: "repository_summary",
    settings: {},
    signal: new AbortController().signal,
    invocation: { id: "fixture", deadline: new Date().toISOString() },
    grants: ["github.metadata.read"],
    guard: async () => {
      if (!allowed) throw new PluginError("plugin_permission_denied");
    },
    broker: async () => {
      allowed = false;
      return {} as Json;
    },
  });
  await expect(
    context.github.getRepository({ repositoryId: 123 }),
  ).rejects.toThrow("plugin_permission_denied");
});

test("complete package inventory is hashed independently of path ordering", async () => {
  const pkg = await loadLocalPackage("examples/plugins/word-count");
  expect(pkg.digest).toBe(
    packageDigest(Object.fromEntries(Object.entries(pkg.files).reverse())),
  );
  expect(validatePackageFiles(pkg.files).manifest.id).toBe("word-count");
  expect(() =>
    validatePackageFiles({
      ...pkg.files,
      [pkg.manifest.runtime.entry]: Buffer.from(""),
    }),
  ).toThrow("plugin_package_invalid");
  expect(() =>
    validatePackageFiles({ ...pkg.files, "../secret": Buffer.from("x") }),
  ).toThrow("plugin_package_invalid");
  expect(
    packageDigest({ ...pkg.files, "guide.md": Buffer.from("changed") }),
  ).not.toBe(pkg.digest);
  expect(safeResourcePath(".github/workflows/check.yml")).toBe(true);
  expect(safeResourcePath("dist/../secret")).toBe(false);
});
