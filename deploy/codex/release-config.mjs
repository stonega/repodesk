// Runs with the release's Node image; no Node installation is required on the VPS.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";

const [root, release, project] = process.argv.slice(2);
if (!root || !release || !/^[a-z0-9][a-z0-9_-]*$/.test(project ?? ""))
  throw Error("Invalid Codex deployment paths or project");
const secrets = join(root, "secrets");
await mkdir(secrets, { recursive: true, mode: 0o700 });
const path = join(secrets, "codex-runner-token");
const configured = parseEnv(
  await readFile(join(root, ".env"), "utf8"),
).CODEX_RUNNER_TOKEN;
let stored;
try {
  stored = (await readFile(path, "utf8")).trim();
} catch (error) {
  if (error.code !== "ENOENT")
    throw Error("Cannot read saved Codex runner token");
}
if (stored && configured && stored !== configured)
  throw Error(
    "Codex runner token changed; drain tasks and explicitly rotate the saved token first",
  );
const token = stored ?? configured ?? randomBytes(32).toString("hex");
if (!/^[A-Za-z0-9_-]{32,256}$/.test(token))
  throw Error("Codex runner token must contain 32–256 URL-safe characters");
if (stored === undefined)
  await writeFile(path, `${token}\n`, { flag: "wx", mode: 0o600 });
await chmod(path, 0o600);
const images = ["CODEX_SUPERVISOR_IMAGE", "CODEX_RUNNER_IMAGE"];
for (const key of images)
  if (!/^sha256:[a-f0-9]{64}$/.test(process.env[key] ?? ""))
    throw Error("Invalid imported Codex image ID");
await writeFile(
  join(release, "codex.env"),
  [
    `CODEX_RUNNER_TOKEN=${token}`,
    ...images.map((key) => `${key}=${process.env[key]}`),
    `CODEX_RUNNER_NETWORK=${project}_codex_tasks`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);

await chmod(join(release, "codex.env"), 0o600);
