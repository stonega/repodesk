import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { TaskState } from "./task-runtime.ts";

export const interruptedJob = z.object({
  executionId: z.uuid(),
  phase: z.enum(["prepare", "setup", "implement", "check"]),
});

export async function hostBootId() {
  try {
    return z
      .uuid()
      .parse(
        (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
      );
  } catch {
    return undefined;
  }
}

/** Record only termination of the job itself, never a child test's exit code. */
export function watchInterruption(
  executionId: string | undefined,
  phase: string | undefined,
  path = "/task/interruption.json",
) {
  const marker = interruptedJob.safeParse({ executionId, phase });
  if (!marker.success) return;
  process.once("SIGTERM", () => {
    try {
      writeFileSync(path, JSON.stringify(marker.data), { mode: 0o600 });
    } finally {
      process.exit(143);
    }
  });
}

export function wasInterrupted(
  state: TaskState,
  marker: unknown,
  executionId: string | undefined,
  phase: string,
  bootChanged: boolean,
) {
  if (!interruptedJob.shape.phase.safeParse(phase).success) return false;
  if (state.Running || state.OOMKilled || ![137, 143].includes(state.ExitCode))
    return false;
  const parsed = interruptedJob.safeParse(marker);
  return (
    (state.ExitCode === 143 &&
      parsed.success &&
      parsed.data.executionId === executionId &&
      parsed.data.phase === phase) ||
    (bootChanged && state.OOMKilled === false)
  );
}
