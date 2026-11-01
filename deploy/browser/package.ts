import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// Operator-run packaging only; no accounts, services or firewall rules change.
const destination = resolve(process.argv[2] ?? "dist/browser-host-package");
await mkdir(destination, { recursive: true });
if ((await readdir(destination)).length)
  throw Error("Choose an empty browser package directory.");
const result = await Bun.build({
  entrypoints: [
    "src/browser/browser-host.ts",
    "src/browser/browser-host-worker.ts",
  ],
  target: "node",
  packages: "external",
  naming: "[name].js",
  outdir: destination,
});
if (!result.success) throw new AggregateError(result.logs, "Host build failed");
await mkdir(join(destination, "node_modules"), { recursive: true });
for (const name of ["playwright-core", "zod"]) {
  const path = dirname(await realpath(`node_modules/${name}/package.json`));
  await cp(path, join(destination, "node_modules", name), {
    recursive: true,
    dereference: true,
  });
}
await writeFile(join(destination, "package.json"), '{"type":"module"}\n');
for (const name of ["repodesk-browser.service", "install.sh"])
  await cp(`deploy/browser/${name}`, join(destination, name));
const manifest: Record<string, string> = {};
for (const file of new Bun.Glob("**/*").scanSync({
  cwd: destination,
  onlyFiles: true,
})) {
  if (file === "manifest.json") continue;
  manifest[file] = createHash("sha256")
    .update(await readFile(join(destination, file)))
    .digest("hex");
}
await writeFile(
  join(destination, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
process.stdout.write(`Browser host package: ${destination}\n`);
