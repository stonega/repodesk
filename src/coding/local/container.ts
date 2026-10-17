import type { RunnerSettings } from "./settings.ts";

export interface ContainerEngine {
  command(args: string[], env?: Record<string, string>): Promise<string>;
  readText(container: string, path: string, maxBytes?: number): Promise<string>;
}
// Read one tiny metadata file from `docker cp ... -` without extracting paths,
// changing ownership, or requiring chroot capabilities in the supervisor.
export function archiveText(archive: Buffer, maxBytes = 4096) {
  let result: string | undefined;
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(
      header.subarray(124, 136).toString("ascii").replace(/\0/g, "").trim(),
      8,
    );
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + 512 + size > archive.length
    )
      throw new Error("Invalid archive");
    const type = header[156];
    if (type === 0 || type === 48) {
      if (result !== undefined || size > maxBytes)
        throw new Error("Invalid metadata");
      result = archive
        .subarray(offset + 512, offset + 512 + size)
        .toString("utf8");
    } else if (type !== 120 && type !== 103)
      throw new Error("Invalid archive entry");
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (result === undefined) throw new Error("Missing metadata");
  return result;
}

export function containerArgs(
  settings: RunnerSettings,
  name: string,
  volume: string,
  mode: string,
  env: Record<string, string> = {},
  authVolume?: string,
) {
  return [
    "create",
    "--name",
    name,
    "--pull=never",
    "--restart=no",
    "--init",
    "--user=1000:1000",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=256",
    `--cpus=${settings.CODEX_RUNNER_CPUS}`,
    `--memory=${settings.CODEX_RUNNER_MEMORY_MB}m`,
    `--memory-swap=${settings.CODEX_RUNNER_MEMORY_MB}m`,
    "--log-driver=none",
    "--tmpfs=/tmp:rw,nosuid,nodev,size=512m,mode=1777",
    `--network=${mode === "export" ? "none" : settings.CODEX_RUNNER_NETWORK}`,
    "--volume",
    `${volume}:/task${mode === "export" ? ":ro" : ""}`,
    ...(authVolume ? ["--volume", `${authVolume}:/auth`] : []),
    ...(mode !== "export"
      ? [
          "--volume",
          `${name.replace(/-(prepare|setup|implement|check|publish)$/, "")}-input:/input:ro`,
        ]
      : []),
    ...Object.keys(env).flatMap((key) => ["--env", key]),
    settings.CODEX_RUNNER_IMAGE,
    mode,
  ];
}
