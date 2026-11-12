import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { nativeIdentity, saveNativeProcess } from "./native-process.ts";

// This process owns a detached process group. Its parent persists the identity
// before releasing stdin, so a lost supervisor can never orphan untracked work.
const [statusPath, outputPath, jobPath, mode] = process.argv.slice(2);
if (!statusPath || !outputPath || !jobPath || !mode) process.exit(1);
let started = false;
process.stdin.once("data", () => {
  started = true;
  void run();
});
process.stdin.once("end", () => {
  if (!started) process.exit(1);
});
async function run() {
  const identity = await nativeIdentity(process.pid);
  const output = await open(outputPath as string, "wx", 0o600);
  let size = 0;
  const child = spawn(process.execPath, [jobPath as string, mode as string], {
    env: process.env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  // Serialize writes and bound export data. Never persist stderr or raw logs.
  let writes = Promise.resolve();
  child.stdout.on("data", (bytes: Buffer) => {
    size += bytes.length;
    if (size > 6 * 1024 * 1024) process.kill(-process.pid, "SIGKILL");
    else
      writes = writes.then(async () => {
        await output.write(bytes);
      });
  });
  let failed = false;
  child.on("error", () => {
    failed = true;
  });
  child.on("close", (code) => {
    void (async () => {
      await writes;
      await output.close();
      await saveNativeProcess(statusPath as string, {
        ...identity,
        exitCode: failed ? 1 : (code ?? 137),
      });
      // Background commands cannot leak into the next phase, including checks.
      process.kill(-process.pid, "SIGKILL");
    })();
  });
}
