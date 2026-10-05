import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Fault } from "../../domain.ts";
import { archiveText, type ContainerEngine } from "./podman.ts";
import type { RunnerSettings } from "./settings.ts";

const exec = promisify(execFile);

/** Only the trusted supervisor receives the daemon socket. */
export class Docker implements ContainerEngine {
  constructor(private settings: RunnerSettings) {}
  private async run(args: string[], env: Record<string, string> = {}) {
    try {
      return await exec(
        "docker",
        ["--host", this.settings.CONTAINER_HOST, ...args],
        {
          env: { PATH: process.env.PATH, HOME: "/tmp", ...env },
          encoding: "buffer",
          timeout: 60000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
    } catch {
      throw new Fault("coding_container_failed", 503);
    }
  }
  async command(args: string[], env: Record<string, string> = {}) {
    if (args.includes("--ignore") && (args[0] === "rm" || args[0] === "stop")) {
      const names = new Set(
        (await this.run(["ps", "--all", "--format", "{{.Names}}"])).stdout
          .toString("utf8")
          .trim()
          .split("\n"),
      );
      // Docker has no --ignore; successful discovery distinguishes absence from outages.
      const targets = args.filter((arg) => arg.startsWith("deepx-codex-"));
      const present = targets.filter((name) => names.has(name));
      if (!present.length) return "";
      args = [
        ...args.filter((arg) => arg !== "--ignore" && !targets.includes(arg)),
        ...present,
      ];
    }
    if (args[0] === "cp") {
      const target = args[2]?.match(
        /^(deepx-codex-[a-f0-9]{32})-[a-z]+:(\/input\/[^/]+)$/,
      );
      if (target) {
        const copier = `${target[1]}-input`;
        // Populate through a stopped root-owned copier, keeping jobs' input mounts read-only.
        await this.command(["rm", "--force", "--ignore", copier]);
        try {
          await this.run([
            "create",
            "--name",
            copier,
            "--pull=never",
            "--user=0:0",
            "--read-only",
            "--network=none",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--log-driver=none",
            "--volume",
            `${copier}:/input`,
            this.settings.CODEX_RUNNER_IMAGE,
          ]);
          return (
            await this.run([
              "cp",
              "--archive",
              args[1] ?? "",
              `${copier}:${target[2]}`,
            ])
          ).stdout
            .toString("utf8")
            .trim();
        } finally {
          await this.command(["rm", "--force", "--ignore", copier]);
        }
      }
      // Preserve the UID of private auth files when copying into a stopped container.
      args = ["cp", "--archive", ...args.slice(1)];
    }
    return (await this.run(args, env)).stdout.toString("utf8").trim();
  }
  async readText(container: string, path: string, maxBytes = 4096) {
    return archiveText(
      (await this.run(["cp", `${container}:${path}`, "-"])).stdout,
      maxBytes,
    );
  }
}
