import { isIP } from "node:net";
import { requireThat } from "../../domain.ts";
import { hash } from "../../setup/credentials.ts";
import type { SandboxDriver, SandboxLaunch } from "./sandbox-runtime.ts";
import type { RunnerSettings } from "./settings.ts";

export class OpenSandboxDriver implements SandboxDriver {
  private module?: Promise<typeof import("@alibaba-group/opensandbox")>;
  private owner: string;
  constructor(
    private settings: RunnerSettings,
    private load = () => import("@alibaba-group/opensandbox"),
  ) {
    requireThat(
      settings.OPENSANDBOX_URL && settings.OPENSANDBOX_API_KEY,
      "coding_opensandbox_not_configured",
      503,
    );
    requireThat(
      !isIP(new URL(settings.CODEX_RUNNER_PROXY_URL).hostname),
      "coding_sandbox_proxy_dns_required",
      503,
    );
    this.owner = hash(
      `${settings.CODEX_RUNNER_TOKEN}:${settings.CODEX_RUNNER_STATE}`,
    ).slice(0, 32);
  }
  private sdk() {
    this.module ??= this.load();
    return this.module;
  }
  private connection() {
    return {
      domain: this.settings.OPENSANDBOX_URL,
      apiKey: this.settings.OPENSANDBOX_API_KEY,
      useServerProxy: true,
      disableMetrics: true,
      requestTimeoutSeconds: 60,
    };
  }
  private metadata(name?: string) {
    return {
      "repodesk-owner": this.owner,
      ...(name ? { "repodesk-phase": name } : {}),
    };
  }
  async ready() {
    const sdk = await this.sdk();
    const manager = sdk.SandboxManager.create({
      connectionConfig: this.connection(),
    });
    try {
      await manager.listSandboxInfos({
        metadata: this.metadata(),
        pageSize: 1,
      });
    } finally {
      await manager.close();
    }
  }
  async create(spec: SandboxLaunch) {
    const sdk = await this.sdk();
    const sandbox = await sdk.Sandbox.create({
      connectionConfig: this.connection(),
      image: spec.image,
      entrypoint: ["tail", "-f", "/dev/null"],
      env: spec.env,
      metadata: this.metadata(spec.name),
      resource: { cpu: String(spec.cpus), memory: `${spec.memoryMb}Mi` },
      timeoutSeconds: null,
      secureAccess: this.settings.OPENSANDBOX_SECURE_ACCESS,
      networkPolicy: {
        defaultAction: "deny",
        egress: spec.network
          ? [
              ...new Set([
                ...this.settings.OPENSANDBOX_ALLOWED_DOMAINS.split(",")
                  .map((d) => d.trim())
                  .filter(Boolean),
                new URL(this.settings.CODEX_RUNNER_PROXY_URL).hostname,
              ]),
            ].map((target) => ({ action: "allow" as const, target }))
          : [],
      },
      volumes: spec.mounts.map((m, i) => ({
        name: `mount-${i}`,
        host: { path: m.source },
        mountPath: m.target,
        readOnly: m.readOnly,
      })),
    });
    try {
      return sandbox.id;
    } finally {
      await sandbox.close();
    }
  }
  private async sandbox(id: string) {
    const sdk = await this.sdk();
    return sdk.Sandbox.connect({
      sandboxId: id,
      connectionConfig: this.connection(),
    });
  }
  async run(id: string, command: string[], attach: boolean) {
    const sandbox = await this.sandbox(id);
    try {
      const result = await sandbox.commands.run(
        // The pinned execd accepts shell form; quote every argument separately.
        command.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" "),
        { background: !attach, uid: 1000, gid: 1000 },
        attach ? undefined : { skipAccumulation: true },
      );
      return {
        jobId: result.id,
        stdout: attach
          ? result.logs.stdout.map((m) => m.text).join("")
          : undefined,
        exitCode: result.exitCode ?? undefined,
      };
    } finally {
      await sandbox.close();
    }
  }
  async inspect(id: string, jobId: string) {
    const sandbox = await this.sandbox(id);
    try {
      const status = await sandbox.commands.getCommandStatus(jobId);
      requireThat(
        typeof status.running === "boolean" &&
          (!status.error ||
            (!status.running && Number.isInteger(status.exitCode))) &&
          (status.running || Number.isInteger(status.exitCode)),
        "coding_outcome_unknown",
        503,
      );
      return {
        Running: status.running,
        Status: status.running ? "running" : "exited",
        ExitCode: status.exitCode ?? 0,
      };
    } finally {
      await sandbox.close();
    }
  }
  async destroy(name: string, id?: string) {
    const sdk = await this.sdk();
    const manager = sdk.SandboxManager.create({
      connectionConfig: this.connection(),
    });
    try {
      // Metadata lookup recovers a create whose response was lost; never create a replacement.
      const result = await manager.listSandboxInfos({
        metadata: this.metadata(name),
        pageSize: 100,
      });
      const active = result.items.filter(
        (s) => s.status.state !== "Terminated",
      );
      requireThat(active.length <= 1, "coding_sandbox_identity_invalid", 503);
      for (const sandbox of active) {
        requireThat(
          (!id || id === sandbox.id) &&
            sandbox.metadata?.["repodesk-owner"] === this.owner &&
            sandbox.metadata?.["repodesk-phase"] === name,
          "coding_sandbox_identity_invalid",
          503,
        );
        await manager.killSandbox(sandbox.id);
      }
    } finally {
      await manager.close();
    }
  }
}
