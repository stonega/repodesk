import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { manifestSchema } from "../src/plugins/manifest.ts";

assert.equal(Bun.version, "1.3.14", "Use the pinned template compiler");
assert.deepEqual(
  JSON.parse(await readFile("sdk/plugin/manifest.schema.json", "utf8")),
  z.toJSONSchema(manifestSchema, { target: "draft-2020-12" }),
);
const temporary = await mkdtemp(join(tmpdir(), "repodesk-author-template-"));
const directory = join(temporary, "standalone");
async function run(args: string[], cwd: string) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${join(process.execPath, "..")}:${process.env.PATH}`,
    },
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`Author command failed: ${args.join(" ")}\n${out}\n${err}`);
  return out;
}
try {
  await cp("templates/plugin", directory, {
    recursive: true,
    filter: (source) => !source.split("/").includes("node_modules"),
  });
  await run(["install", "--frozen-lockfile"], directory);
  for (const command of [
    "check",
    "typecheck",
    "test",
    "build",
    "validate",
    "example",
  ])
    await run(["run", command], directory);
  for (const path of ["src/generated/contract.ts", "dist/plugin.mjs"])
    assert.equal(
      await readFile(join(directory, path), "utf8"),
      await readFile(join("templates/plugin", path), "utf8"),
      `Template rebuild drift: ${path}`,
    );
  console.log(
    "Portable author template passed from an independent temporary directory.",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
