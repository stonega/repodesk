import { constants } from "node:fs";
import { open, readdir, readFile, rename, writeFile } from "node:fs/promises";

export interface NativeProcess {
  pid: number;
  start: string;
  boot: string;
  exitCode?: number;
}

/** A PID alone is not an identity: it can belong to another process after restart. */
export async function nativeIdentity(pid: number) {
  const [stat, boot] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8"),
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
  ]);
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const start = fields[19]; // field 22, after the parenthesized comm field
  if (!start || !/^\d+$/.test(start)) throw Error("coding_outcome_unknown");
  return { pid, start, boot: boot.trim() };
}

export async function readNativeProcess(path: string): Promise<NativeProcess> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096)
      throw Error("coding_outcome_unknown");
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw Error("coding_outcome_unknown");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await file.close();
  }
}

export async function saveNativeProcess(path: string, value: NativeProcess) {
  await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

export function nativeGroupExists(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function groupRunning(pid: number) {
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await readFile(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      // Unreaped zombies cannot execute or write task files.
      if (fields[2] === String(pid) && fields[0] !== "Z" && fields[0] !== "X")
        return true;
    } catch (error) {
      if (
        !["ENOENT", "ESRCH", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  }
  return false;
}

/** Never signal a reused PID/group. Missing leaders with live descendants are uncertain. */
export async function stopNativeProcess(saved: NativeProcess) {
  let current: Awaited<ReturnType<typeof nativeIdentity>>;
  try {
    current = await nativeIdentity(saved.pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (nativeGroupExists(saved.pid) && (await groupRunning(saved.pid)))
      throw Error("coding_outcome_unknown");
    return;
  }
  if (current.boot !== saved.boot) return; // No process survives a host reboot.
  if (current.start !== saved.start) throw Error("coding_outcome_unknown");
  try {
    process.kill(-saved.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + 5000;
  while (await groupRunning(saved.pid)) {
    if (Date.now() >= deadline) throw Error("coding_outcome_unknown");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
