import { cp, mkdir, readFile, writeFile } from "node:fs/promises";

// Rebuild the portable author tool; no application server or Pi is bundled.
const destination = "templates/plugin/.repodesk";
await mkdir(`${destination}/scripts`, { recursive: true });
await mkdir(`${destination}/sdk`, { recursive: true });
const cli = await Bun.build({
  entrypoints: ["scripts/plugin-cli.ts"],
  target: "bun",
  format: "esm",
  outdir: `${destination}/scripts`,
  naming: "plugin-cli.mjs",
});
if (!cli.success) throw new AggregateError(cli.logs, "Plugin CLI build failed");
for (const name of [
  "index.ts",
  "package.json",
  "manifest.schema.json",
  "README.md",
])
  await cp(`sdk/plugin/${name}`, `${destination}/sdk/plugin/${name}`, {
    recursive: true,
  });
const notices = [];
for (const name of ["zod", "yaml", "marked"]) {
  const pkg = JSON.parse(
    await readFile(`node_modules/${name}/package.json`, "utf8"),
  );
  let license: string;
  try {
    license = await readFile(`node_modules/${name}/LICENSE`, "utf8");
  } catch {
    license = await readFile(`node_modules/${name}/LICENSE.md`, "utf8");
  }
  notices.push(`${name} ${pkg.version}\n${license}`);
}
await writeFile(`${destination}/THIRD-PARTY-NOTICES.txt`, notices.join("\n\n"));
