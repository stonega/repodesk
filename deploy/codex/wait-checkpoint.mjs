// Read inside the existing runner. Never stop tasks or print private state.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

const seconds = Number(process.argv[2]);
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 1800)
  throw Error("Checkpoint wait must be 1–1800 seconds");
const root = process.env.CODEX_RUNNER_STATE ?? "/var/lib/deepx-codex";
const deadline = Date.now() + seconds * 1000;
const safe = new Set([
  "ready",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
  "auth_required",
]);
let lastCount;
let lastNotice = 0;
for (;;) {
  let active = 0;
  for (const name of await readdir(root)) {
    if (!/^deepx-codex-[a-f0-9]{32}\.json$/.test(name)) continue;
    let record;
    try {
      record = JSON.parse(await readFile(join(root, name), "utf8"));
    } catch {
      throw Error(
        "Cannot read coding checkpoint state; runner replacement refused",
      );
    }
    if (
      !record ||
      typeof record !== "object" ||
      typeof record.state !== "string"
    )
      throw Error(
        "Invalid coding checkpoint state; runner replacement refused",
      );
    if (!record.cleaned && !safe.has(record.state)) active++;
  }
  if (active === 0) break;
  if (Date.now() >= deadline)
    throw Error("Coding tasks are still running; deployment deferred");
  if (lastCount !== active || Date.now() - lastNotice >= 30000) {
    console.log(
      `Waiting for ${active} coding attempt(s) to reach a checkpoint.`,
    );
    lastCount = active;
    lastNotice = Date.now();
  }
  await setTimeout(Math.min(1000, deadline - Date.now()));
}
console.log("Coding attempts are at durable checkpoints.");
