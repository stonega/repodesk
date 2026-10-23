import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";

const backend = await Bun.build({
  entrypoints: [
    "src/server.ts",
    "src/worker.ts",
    "src/web-reader/web-reader-extract.ts",
    "src/coding/local/runner-server.ts",
    "src/coding/local/job.ts",
    "src/db/migrate.ts",
    "scripts/operator.ts",
    "scripts/evaluate.ts",
    "scripts/runtime-contract.ts",
    "scripts/register-webhook.ts",
    "scripts/code-truth-token.ts",
  ],
  outdir: "dist",
  target: "node",
  packages: "external",
  naming: "[name].js",
});
if (!backend.success)
  throw new AggregateError(backend.logs, "Backend build failed");
await cp("src/agent/SOUL.md", "dist/SOUL.md");
await cp("src/transcription/qwen-asr.py", "dist/qwen-asr.py");
const frontend = await Bun.build({
  entrypoints: ["web/app.tsx", "web/theme-init.ts", "web/mini.tsx"],
  outdir: "dist/web/assets",
  target: "browser",
  minify: true,
  naming: "[name].[ext]",
});
if (!frontend.success)
  throw new AggregateError(frontend.logs, "Frontend build failed");
await mkdir("dist/web", { recursive: true });
await cp("web/style.css", "dist/web/assets/style.css");
await cp("web/assets/repodesk-mark.svg", "dist/web/assets/repodesk-mark.svg");
let html = await readFile("web/index.html", "utf8");
const { version: appVersion } = JSON.parse(
  await readFile("package.json", "utf8"),
);
html = html.replace("__APP_VERSION__", appVersion);
for (const asset of ["app.js", "theme-init.js", "style.css"]) {
  const content = await readFile(`dist/web/assets/${asset}`);
  const version = createHash("sha256")
    .update(content)
    .digest("hex")
    .slice(0, 16);
  html = html.replace(`/assets/${asset}`, `/assets/${asset}?v=${version}`);
}
await writeFile("dist/web/index.html", html);
await cp("web/mini.css", "dist/web/assets/mini.css");
let mini = await readFile("web/mini.html", "utf8");
for (const asset of ["mini.js", "mini.css"]) {
  const version = createHash("sha256")
    .update(await readFile(`dist/web/assets/${asset}`))
    .digest("hex")
    .slice(0, 16);
  mini = mini.replace(`/assets/${asset}`, `/assets/${asset}?v=${version}`);
}
await writeFile("dist/web/mini.html", mini);
