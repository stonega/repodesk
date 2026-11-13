import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  type Capability,
  type Json,
  PluginError,
} from "../src/plugins/contract.ts";
import {
  createToolContext,
  validateDefinition,
  validateInput,
  validateResult,
  validateSettings,
} from "../src/plugins/invocation.ts";
import {
  generatedContractPath,
  loadLocalPackage,
  readLocalManifest,
} from "../src/plugins/local-package.ts";
import { generateContract, manifestSchema } from "../src/plugins/manifest.ts";

const [command, directory = ".", tool, inputFile, fixtureFile, unsafe] =
  process.argv.slice(2);
try {
  if (command === "schema") {
    process.stdout.write(
      `${JSON.stringify(z.toJSONSchema(manifestSchema, { target: "draft-2020-12" }), null, 2)}\n`,
    );
  } else if (command === "generate") {
    const manifest = await readLocalManifest(directory);
    const path = generatedContractPath(directory);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, generateContract(manifest));
    process.stdout.write("Generated plugin types.\n");
  } else if (command === "build") {
    const manifest = await readLocalManifest(directory);
    const generated = generatedContractPath(directory);
    await mkdir(dirname(generated), { recursive: true });
    await writeFile(generated, generateContract(manifest));
    const output = resolve(directory, manifest.runtime.entry);
    const result = await Bun.build({
      entrypoints: [resolve(directory, "src/index.ts")],
      root: resolve(directory),
      target: "node",
      format: "esm",
      outdir: dirname(output),
      naming: output.split("/").at(-1),
      plugins: [
        {
          name: "repodesk-preview-sdk",
          setup(build) {
            build.onResolve({ filter: /^@repodesk\/plugin-sdk$/ }, () => ({
              path: resolve(
                dirname(resolve(process.argv[1] ?? "scripts/plugin-cli.ts")),
                "../sdk/plugin/index.ts",
              ),
            }));
          },
        },
      ],
    });
    if (!result.success) throw new PluginError("plugin_package_invalid");
    await loadLocalPackage(directory);
    process.stdout.write("Built and validated Node ESM plugin.\n");
  } else if (command === "validate") {
    const pkg = await loadLocalPackage(directory);
    process.stdout.write(
      `${JSON.stringify({ id: pkg.manifest.id, version: pkg.manifest.version, digest: pkg.digest, tools: pkg.manifest.tools.map((t) => t.name) })}\n`,
    );
  } else if (command === "run") {
    // Deliberately explicit: local imports are trusted development, never a sandbox.
    if (!tool || !inputFile || !fixtureFile || unsafe !== "--unsafe-local")
      throw new PluginError("plugin_permission_denied");
    const pkg = await loadLocalPackage(directory);
    const fixtures = z
      .object({
        grants: z.array(z.enum(["github.metadata.read", "http.read"])),
        responses: z.record(z.string(), z.json()),
        settings: z.record(z.string(), z.json()).optional(),
      })
      .strict()
      .parse(JSON.parse(await readFile(fixtureFile, "utf8")));
    const input = validateInput(
      pkg.manifest,
      tool,
      JSON.parse(await readFile(inputFile, "utf8")),
    );
    const settings = validateSettings(pkg.manifest, fixtures.settings ?? {});
    const definition = validateDefinition(
      pkg.manifest,
      (
        await import(
          pathToFileURL(resolve(directory, pkg.manifest.runtime.entry)).href
        )
      ).default,
    );
    const context = createToolContext({
      manifest: pkg.manifest,
      tool,
      settings,
      signal: AbortSignal.timeout(30000),
      invocation: {
        id: randomUUID(),
        deadline: new Date(Date.now() + 30000).toISOString(),
      },
      grants: fixtures.grants as Capability[],
      guard: async () => {},
      broker: async (request) => {
        const key = JSON.stringify(request);
        if (!Object.hasOwn(fixtures.responses, key))
          throw new PluginError("plugin_permission_denied");
        return fixtures.responses[key] as Json;
      },
    });
    const handler = definition.tools[tool];
    if (!handler) throw new PluginError("plugin_package_invalid");
    const result = validateResult(
      pkg.manifest,
      tool,
      await handler(input, context),
    );
    process.stdout.write(
      `${JSON.stringify({ mode: "trusted-offline-harness-without-os-isolation", result })}\n`,
    );
  } else {
    process.stderr.write(
      "Usage: plugin-cli <schema|generate|build|validate> [directory]\n       plugin-cli run <directory> <tool> <input.json> <fixtures.json> --unsafe-local\n",
    );
    process.exitCode = 1;
  }
} catch (error) {
  // Never print author exceptions, inputs, paths, credentials or subprocess output.
  process.stderr.write(
    `${error instanceof PluginError ? error.code : "plugin_package_invalid"}\n`,
  );
  process.exitCode = 1;
}
