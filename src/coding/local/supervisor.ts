import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Fault, requireThat } from "../../domain.ts";
import {
  decrypt,
  encrypt,
  equal,
  fingerprint,
  hash,
} from "../../setup/credentials.ts";
import { type ContainerEngine, containerArgs } from "./podman.ts";
import {
  type LocalRunner,
  type LocalStart,
  type LocalStatus,
  localStart,
} from "./protocol.ts";
import { codexConfig, type RunnerSettings } from "./settings.ts";

interface Record extends LocalStatus {
  key: string;
  input: Omit<LocalStart, "readToken" | "providerApiKey">;
  providerApiKey?: string; // Encrypted task credential; never copied into job input.
  phase: "prepare" | "implement" | "publish";
  proxyToken: string;
  createdAt: number;
  finishedAt?: number;
  cleaned?: boolean;
  baseSha?: string;
}
const terminal = (state: string) =>
  ["succeeded", "failed", "cancelled", "unknown"].includes(state);
export const taskKey = (workspaceId: string, taskId: string) => {
  z.uuid().parse(workspaceId);
  z.uuid().parse(taskId);
  return `deepx-codex-${createHash("sha256").update(`${workspaceId}:${taskId}`).digest("hex").slice(0, 32)}`;
};

export class RunnerSupervisor implements LocalRunner {
  private records = new Map<string, Record>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly settings: RunnerSettings,
    private engine: ContainerEngine,
  ) {}
  async initialize() {
    await mkdir(this.settings.CODEX_RUNNER_STATE, {
      recursive: true,
      mode: 0o700,
    });
    for (const name of await readdir(this.settings.CODEX_RUNNER_STATE)) {
      if (!/^deepx-codex-[a-f0-9]{32}\.json$/.test(name)) continue;
      const r = JSON.parse(
        await readFile(join(this.settings.CODEX_RUNNER_STATE, name), "utf8"),
      ) as Record;
      requireThat(
        r.key === taskKey(r.input.workspaceId, r.input.taskId),
        "coding_state_invalid",
      );
      this.records.set(r.key, r);
    }
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }
  private path(r: Record, suffix: string) {
    return join(this.settings.CODEX_RUNNER_STATE, `${r.key}.${suffix}`);
  }
  private async save(r: Record) {
    if (!["preparing", "running"].includes(r.state)) delete r.providerApiKey;
    if (terminal(r.state) && !r.finishedAt) r.finishedAt = Date.now();
    await writeFile(this.path(r, "json.tmp"), JSON.stringify(r), {
      mode: 0o600,
    });
    await rename(this.path(r, "json.tmp"), this.path(r, "json"));
    this.records.set(r.key, r);
  }
  private get(workspaceId: string, taskId: string) {
    const r = this.records.get(taskKey(workspaceId, taskId));
    requireThat(r, "coding_task_not_found", 404);
    return r;
  }
  private view(r: Record): LocalStatus {
    return {
      state: r.state,
      threadId: r.threadId,
      prUrl: r.prUrl,
      error: r.error,
    };
  }
  private volume(r: Record, mode: string) {
    return `${r.key}-${mode === "publish" ? "publish" : "work"}`;
  }
  private async launch(
    r: Record,
    mode: string,
    env: { [key: string]: string } = {},
  ) {
    const name = `${r.key}-${mode}`;
    await this.engine.command(
      containerArgs(this.settings, name, this.volume(r, mode), mode, env),
      env,
    );
    if (mode !== "export") {
      const file = this.path(r, "input");
      await writeFile(
        file,
        JSON.stringify({
          ...r.input,
          baseSha: r.baseSha,
          config: codexConfig(this.settings),
        }),
        { mode: 0o644 },
      );
      await this.engine.command(["cp", file, `${name}:/input/job.json`]);
      await rm(file);
      if (mode === "publish")
        await this.engine.command([
          "cp",
          this.path(r, "patch"),
          `${name}:/input/patch`,
        ]);
    }
    return this.engine.command(
      mode === "export" ? ["start", "--attach", name] : ["start", name],
    );
  }
  async start(input: LocalStart) {
    return this.serial(async () => {
      const { readToken, providerApiKey, ...safe } = localStart.parse(input);
      requireThat(
        safe.payload.backend === "podman" && safe.payload.checkCommand,
        "coding_job_invalid",
      );
      const key = taskKey(safe.workspaceId, safe.taskId);
      const prior = this.records.get(key);
      if (prior) {
        requireThat(
          fingerprint(prior.input) === fingerprint(safe),
          "coding_task_conflict",
          409,
        );
        return; // A repeated request never launches a second container.
      }
      requireThat(
        ![...this.records.values()].some((r) => !terminal(r.state)),
        "coding_runner_busy",
        429,
      );
      requireThat(
        providerApiKey || this.settings.CODEX_PROVIDER_API_KEY,
        "coding_provider_not_configured",
        409,
      );
      const r: Record = {
        providerApiKey: providerApiKey
          ? encrypt(
              hash(this.settings.CODEX_RUNNER_TOKEN),
              `coding-provider:${key}`,
              providerApiKey,
            )
          : undefined,
        key,
        input: safe,
        phase: "prepare",
        state: "preparing",
        proxyToken: randomBytes(32).toString("hex"),
        createdAt: Date.now(),
      };
      await this.save(r); // Reserve before invoking the engine.
      try {
        await this.launch(r, "prepare", { GITHUB_TOKEN: readToken });
      } catch {
        r.state = "unknown";
        r.error = "coding_container_failed";
        await this.save(r);
        throw new Fault("coding_outcome_unknown", 503);
      }
    });
  }
  async status(workspaceId: string, taskId: string) {
    return this.serial(async () => {
      const r = this.get(workspaceId, taskId);
      await this.advance(r);
      return this.view(r);
    });
  }
  private async copyResult(r: Record, filename: string) {
    return this.engine.readText(`${r.key}-${r.phase}`, `/task/${filename}`);
  }
  private async advance(r: Record) {
    if (terminal(r.state) || r.state === "ready") return;
    try {
      if (
        Date.now() >
        r.createdAt + this.settings.CODEX_RUNNER_TIMEOUT_SECONDS * 1000
      ) {
        await this.stop(r);
        r.error = "coding_task_timeout";
        await this.save(r);
        return;
      }
      const raw = await this.engine.command([
        "inspect",
        "--format",
        "{{json .State}}",
        `${r.key}-${r.phase}`,
      ]);
      const state = z
        .object({
          Running: z.boolean(),
          Status: z.string(),
          ExitCode: z.number(),
        })
        .parse(JSON.parse(raw));
      if (state.Running) return;
      if (state.Status !== "exited" && state.Status !== "stopped")
        throw new Error("Incomplete container start");
      if (state.ExitCode !== 0) {
        r.state = r.phase === "publish" ? "unknown" : "failed";
        r.error =
          r.phase === "publish"
            ? "coding_publication_unknown"
            : "coding_execution_failed";
      } else if (r.phase === "prepare") {
        r.baseSha = z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .parse((await this.copyResult(r, "base-sha")).trim());
        r.phase = "implement";
        r.state = "running";
        await this.save(r);
        await this.launch(r, "implement", { CODEX_TASK_TOKEN: r.proxyToken });
      } else if (r.phase === "implement") {
        // Record export reservation before creation; an interrupted export is not rerun.
        const exported = JSON.parse(await this.launch(r, "export"));
        const artifact = z
          .object({
            patch: z
              .string()
              .min(1)
              .max(5 * 1024 * 1024),
            threadId: z
              .string()
              .regex(/^[a-zA-Z0-9-]{1,100}$/)
              .optional(),
          })
          .parse(exported);
        await writeFile(this.path(r, "patch"), artifact.patch, { mode: 0o644 });
        r.threadId = artifact.threadId;
        r.state = "ready";
      } else {
        const result = z
          .object({ prUrl: z.string().url() })
          .parse(JSON.parse(await this.copyResult(r, "publication.json")));
        requireThat(
          result.prUrl.startsWith(
            `https://github.com/${r.input.payload.repository}/pull/`,
          ),
          "coding_pr_missing",
        );
        r.prUrl = result.prUrl;
        r.state = "succeeded";
      }
      await this.save(r);
    } catch {
      // Reconcile engine outages on the next poll. Container names prevent duplicate starts.
      throw new Fault("coding_runner_unavailable", 503);
    }
  }
  async publish(workspaceId: string, taskId: string, token: string) {
    return this.serial(async () => {
      const r = this.get(workspaceId, taskId);
      if (r.phase === "publish") return;
      requireThat(
        r.state === "ready" &&
          Date.now() <
            r.createdAt + this.settings.CODEX_RUNNER_TIMEOUT_SECONDS * 1000,
        "coding_task_not_ready",
        409,
      );
      r.state = "publishing";
      r.phase = "publish";
      await this.save(r);
      try {
        await this.launch(r, "publish", { GITHUB_TOKEN: token });
      } catch {
        r.state = "unknown";
        r.error = "coding_publication_unknown";
        await this.save(r);
        throw new Fault("coding_outcome_unknown", 503);
      }
    });
  }
  private async stop(r: Record) {
    if (terminal(r.state)) return;
    // `rm --force --ignore` also handles a reservation that never created a container.
    await this.engine.command([
      "rm",
      "--force",
      "--ignore",
      `${r.key}-${r.phase}`,
    ]);
    r.state = r.phase === "publish" ? "unknown" : "cancelled";
    await this.save(r);
  }
  async cancel(workspaceId: string, taskId: string) {
    return this.serial(() => this.stop(this.get(workspaceId, taskId)));
  }
  providerKey(token: string): string {
    const record = [...this.records.values()].find(
      (r) =>
        r.state === "running" &&
        r.phase === "implement" &&
        Date.now() <
          r.createdAt + this.settings.CODEX_RUNNER_TIMEOUT_SECONDS * 1000 &&
        equal(token, r.proxyToken),
    );
    requireThat(record, "coding_proxy_denied", 401);
    const key = record.providerApiKey
      ? decrypt(
          hash(this.settings.CODEX_RUNNER_TOKEN),
          `coding-provider:${record.key}`,
          record.providerApiKey,
        )
      : this.settings.CODEX_PROVIDER_API_KEY;
    requireThat(key, "coding_provider_not_configured", 409);
    return key;
  }
  async sweep() {
    return this.serial(async () => {
      for (const r of this.records.values()) {
        if (
          !terminal(r.state) &&
          Date.now() >
            r.createdAt + this.settings.CODEX_RUNNER_TIMEOUT_SECONDS * 1000
        )
          await this.stop(r);
        if (!terminal(r.state)) await this.advance(r);
        if (
          !r.cleaned &&
          r.finishedAt &&
          Date.now() >
            r.finishedAt + this.settings.CODEX_RUNNER_RETENTION_HOURS * 3600000
        ) {
          await this.engine.command([
            "rm",
            "--force",
            "--ignore",
            ...["prepare", "implement", "export", "publish"].map(
              (p) => `${r.key}-${p}`,
            ),
          ]);
          const volumes = (
            await this.engine.command([
              "volume",
              "ls",
              "--format",
              "{{.Name}}",
              "--filter",
              `name=${r.key}`,
            ])
          )
            .split("\n")
            .filter(
              (name) => name === `${r.key}-work` || name === `${r.key}-publish`,
            );
          if (volumes.length)
            await this.engine.command(["volume", "rm", "--force", ...volumes]);
          for (const suffix of ["patch", "result", "input"])
            await rm(this.path(r, suffix), { force: true });
          // Keep a small tombstone so delayed duplicate requests cannot replay the task.
          r.cleaned = true;
          r.proxyToken = "";
          r.input.payload.body = "[expired]";
          await this.save(r);
        }
      }
    });
  }
}
