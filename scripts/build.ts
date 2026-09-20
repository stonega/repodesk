import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";

const backend = await Bun.build({
  entrypoints: [
    "src/server.ts",
    "src/worker.ts",
    "src/db/migrate.ts",
    "scripts/operator.ts",
    "scripts/evaluate.ts",
    "scripts/runtime-contract.ts",
    "scripts/register-webhook.ts",
  ],
  outdir: "dist",
  target: "node",
  packages: "external",
  naming: "[name].js",
});
if (!backend.success)
  throw new AggregateError(backend.logs, "Backend build failed");
const frontend = await Bun.build({
  entrypoints: ["web/app.tsx"],
  outdir: "dist/web/assets",
  target: "browser",
  minify: true,
  naming: "[name].[ext]",
});
if (!frontend.success)
  throw new AggregateError(frontend.logs, "Frontend build failed");
await mkdir("dist/web", { recursive: true });
await cp("web/style.css", "dist/web/assets/style.css");
let html = await readFile("web/index.html", "utf8");
for (const asset of ["app.js", "style.css"]) {
  const content = await readFile(`dist/web/assets/${asset}`);
  const version = createHash("sha256")
    .update(content)
    .digest("hex")
    .slice(0, 16);
  html = html.replace(`/assets/${asset}`, `/assets/${asset}?v=${version}`);
}
await writeFile("dist/web/index.html", html);
