import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  chown,
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
import {
  developmentResult,
  developmentResultByteLimit,
  developmentRun,
  verificationCommands,
} from "../development.ts";
import { resultIssues, safeResultIssues } from "../result-validation.ts";
import { conversationFailureCodes } from "./conversation-failure.ts";
import { DeviceAuth } from "./device-auth.ts";
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
  phase: "prepare" | "setup" | "implement" | "check" | "publish";
  verificationCommands?: string[];
  proxyToken: string;
  createdAt: number;
  finishedAt?: number;
  repairs?: number;
  checkpointId?: string;
  checkpointLost?: boolean;
  cleaned?: boolean;
  baseSha?: string;
  authGeneration?: string;
  authPausedAt?: number;
}
const terminal = (state: string) =>
  ["succeeded", "failed", "cancelled", "unknown", "auth_required"].includes(
    state,
  );
const implementationFailures = new Set([
  ...conversationFailureCodes,
  "coding_setup_failed",
  "coding_review_preparation_failed",
  "coding_codex_failed",
  "coding_check_failed",
  "coding_patch_empty",
]);
export const taskKey = (workspaceId: string, taskId: string) => {
  z.uuid().parse(workspaceId);
  z.uuid().parse(taskId);
  return `deepx-codex-${createHash("sha256").update(`${workspaceId}:${taskId}`).digest("hex").slice(0, 32)}`;
};

export class RunnerSupervisor implements LocalRunner {
  readonly device: DeviceAuth;
  private records = new Map<string, Record>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly settings: RunnerSettings,
    private engine: ContainerEngine,
  ) {
    this.device = new DeviceAuth(settings);
  }
  async initialize() {
    await mkdir(this.settings.CODEX_RUNNER_STATE, {
      recursive: true,
      mode: 0o700,
    });
    await chmod(this.settings.CODEX_RUNNER_STATE, 0o700);
    await this.device.initialize();
    for (const name of await readdir(this.settings.CODEX_RUNNER_STATE)) {
      if (/^deepx-codex-[a-f0-9]{32}\.auth$/.test(name)) {
        await rm(join(this.settings.CODEX_RUNNER_STATE, name), { force: true });
        continue;
      }
      if (!/^deepx-codex-[a-f0-9]{32}\.json$/.test(name)) continue;
      const r = JSON.parse(
        await readFile(join(this.settings.CODEX_RUNNER_STATE, name), "utf8"),
      ) as Record;
      if (r.input.development && !r.cleaned)
        r.input.development = developmentRun.parse(r.input.development);
      requireThat(
        r.key === taskKey(r.input.workspaceId, r.input.taskId),
        "coding_state_invalid",
      );
      this.records.set(r.key, r);
    }
  }
  async ready() {
    await this.engine.command([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      this.settings.CODEX_RUNNER_IMAGE,
    ]);
    await this.engine.command([
      "network",
      "inspect",
      this.settings.CODEX_RUNNER_NETWORK,
    ]);
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
  private hasCapacity() {
    return (
      [...this.records.values()].filter((r) => !terminal(r.state)).length <
      this.settings.CODEX_RUNNER_CONCURRENCY
    );
  }
  private canRunTask(input: Record["input"]) {
    return ![...this.records.values()].some(
      (r) =>
        !terminal(r.state) &&
        r.input.workspaceId === input.workspaceId &&
        input.development &&
        r.input.development?.taskId === input.development.taskId,
    );
  }
  private canImplement(r: Record) {
    // Codex rotates managed account credentials. Each workspace cache needs one
    // implementation stream; preparation, checks and publication can overlap.
    return (
      r.input.payload.authMode !== "device_code" ||
      ![...this.records.values()].some(
        (other) =>
          other !== r &&
          !terminal(other.state) &&
          other.phase === "implement" &&
          other.input.payload.authMode === "device_code" &&
          other.input.workspaceId === r.input.workspaceId,
      )
    );
  }
  private view(r: Record): LocalStatus {
    return {
      state: r.state,
      threadId: r.threadId,
      prUrl: r.prUrl,
      error: r.error,
      phase: r.phase,
      result: r.result,
      tokens: r.tokens,
      usageUnknown: r.usageUnknown,
      resultIssues: r.resultIssues,
      baseSha: r.baseSha,
      publishedSha: r.publishedSha,
      checkPassed: r.checkPassed,
      repairCount: r.repairs,
    };
  }
  private volume(r: Record, mode: string) {
    return `${r.key}-${mode === "publish" ? "publish" : "work"}`;
  }
  private authVolume(r: Record) {
    return `${r.key}-auth`;
  }
  private async captureAuth(r: Record) {
    if (r.input.payload.authMode !== "device_code") return;
    const credential = await this.engine.readText(
      `${r.key}-implement`,
      "/auth/auth.json",
      128 * 1024,
    );
    // A legacy in-flight record can finish, but cannot overwrite a newer login.
    if (r.authGeneration)
      await this.device.capture(
        r.input.workspaceId,
        r.authGeneration,
        credential,
      );
  }
  private async removeAuthVolume(r: Record) {
    if (r.input.payload.authMode !== "device_code") return;
    await this.engine.command([
      "rm",
      "--force",
      "--ignore",
      `${r.key}-implement`,
    ]);
    const name = this.authVolume(r);
    const volumes = await this.engine.command([
      "volume",
      "ls",
      "--format",
      "{{.Name}}",
      "--filter",
      `name=${name}`,
    ]);
    if (volumes.split("\n").includes(name))
      await this.engine.command(["volume", "rm", "--force", name]);
  }
  private async copyInput(file: string, target: string) {
    // Docker copies into a root-owned input volume; the job UID may only read it.
    if (this.settings.CODEX_CONTAINER_ENGINE === "docker")
      await chmod(file, 0o644);
    await this.engine.command(["cp", file, target]);
  }
  private async launch(
    r: Record,
    mode: string,
    env: { [key: string]: string } = {},
  ) {
    const name = `${r.key}-${mode}`;
    const deviceRun =
      mode === "implement" && r.input.payload.authMode === "device_code";
    if (deviceRun)
      await this.engine.command(["volume", "create", this.authVolume(r)]);
    await this.engine.command(
      containerArgs(
        this.settings,
        name,
        this.volume(r, mode),
        mode,
        env,
        deviceRun ? this.authVolume(r) : undefined,
      ),
      env,
    );
    if (deviceRun) {
      const credential = this.path(r, "auth");
      try {
        await writeFile(
          credential,
          await (async () => {
            const auth = await this.device.snapshot(r.input.workspaceId);
            r.authGeneration = auth.generation;
            await this.save(r);
            return auth.credential;
          })(),
          { mode: 0o600 },
        );
        if (this.settings.CODEX_CONTAINER_ENGINE === "docker") {
          // The root supervisor reads via its group; the job UID owns the private copy.
          await chmod(credential, 0o640);
          await chown(credential, 1000, 0);
        }
        await this.engine.command([
          "cp",
          credential,
          `${name}:/auth/auth.json`,
        ]);
      } finally {
        await rm(credential, { force: true });
      }
    }
    if (mode !== "export") {
      const file = this.path(r, "input");
      await writeFile(
        file,
        JSON.stringify({
          ...r.input,
          ...(r.input.development
            ? {
                development: {
                  ...r.input.development,
                  threadId: r.threadId ?? r.input.development.threadId,
                  context: r.checkpointLost
                    ? `Prior work checkpoint is unavailable for the current branch head. Reconstruct the implementation from authenticated requirements and current code; do not claim the old patch survived.\n${r.input.development.context}`.slice(
                        0,
                        40000,
                      )
                    : r.input.development.context,
                },
              }
            : {}),
          baseSha: r.baseSha,
          verificationCommands: r.verificationCommands,
          config: codexConfig(
            this.settings,
            r.input.payload.authMode,
            r.input.modelProvider,
          ),
        }),
        { mode: 0o644 },
      );
      await this.copyInput(file, `${name}:/input/job.json`);
      await rm(file);
      if (mode === "prepare" && r.checkpointId) {
        const prior = this.get(r.input.workspaceId, r.checkpointId);
        await this.copyInput(
          this.path(prior, "patch"),
          `${name}:/input/checkpoint.patch`,
        );
      }
      if (mode === "publish" && r.input.development)
        await this.copyInput(
          this.path(r, "conversation"),
          `${name}:/input/conversation.json`,
        );
      if (mode === "publish")
        await this.copyInput(this.path(r, "patch"), `${name}:/input/patch`);
    }
    return this.engine.command(
      mode === "export" ? ["start", "--attach", name] : ["start", name],
    );
  }
  async start(input: LocalStart) {
    return this.serial(async () => {
      const { readToken, providerApiKey, ...safe } = localStart.parse(input);
      requireThat(
        safe.payload.backend === "podman" && (safe.issue || safe.development),
        "coding_job_invalid",
      );
      const key = taskKey(safe.workspaceId, safe.taskId);
      const prior = this.records.get(key);
      if (prior) {
        requireThat(!prior.cleaned, "coding_task_stopped", 409);
        requireThat(
          fingerprint(prior.input) === fingerprint(safe),
          "coding_task_conflict",
          409,
        );
        return; // A repeated request never launches a second container.
      }
      requireThat(
        this.hasCapacity() && this.canRunTask(safe),
        "coding_runner_busy",
        429,
      );
      if (safe.payload.authMode === "device_code")
        await this.device.read(safe.workspaceId);
      else
        requireThat(
          providerApiKey || this.settings.CODEX_PROVIDER_API_KEY,
          "coding_provider_not_configured",
          409,
        );
      const r: Record = {
        providerApiKey:
          safe.payload.authMode === "provider_key" && providerApiKey
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
      if (safe.development?.previousAttemptId) {
        const checkpoint = this.records.get(
          taskKey(safe.workspaceId, safe.development.previousAttemptId),
        );
        if (checkpoint && !checkpoint.cleaned) {
          requireThat(
            checkpoint.input.development?.taskId === safe.development.taskId &&
              checkpoint.input.payload.repositoryId ===
                safe.payload.repositoryId &&
              checkpoint.baseSha,
            "coding_checkpoint_invalid",
            409,
          );
          if (
            !safe.development.pr ||
            checkpoint.baseSha === safe.development.pr.headSha
          ) {
            r.baseSha = checkpoint.baseSha;
            r.checkpointId = checkpoint.input.taskId;
          } else r.checkpointLost = true;
        } else r.checkpointLost = true;
      }
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
    if (r.state === "auth_required" && !r.cleaned) {
      await this.removeAuthVolume(r);
      return;
    }
    if (terminal(r.state) || r.state === "ready") return;
    try {
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
      if (
        r.phase === "implement" &&
        r.input.payload.authMode === "device_code"
      ) {
        if (
          state.ExitCode !== 0 &&
          (await this.copyResult(r, "failure-code").catch(() => "")).trim() ===
            "coding_device_auth_required"
        ) {
          if (r.input.development) {
            let metadata: unknown;
            try {
              metadata = JSON.parse(
                await this.engine.readText(
                  `${r.key}-implement`,
                  "/task/auth-failure.json",
                  4096,
                ),
              );
            } catch {
              metadata = {};
            }
            const usage = z
              .object({
                threadId: z
                  .string()
                  .regex(/^[a-zA-Z0-9-]{1,100}$/)
                  .optional(),
                tokens: z.number().int().nonnegative().optional(),
                usageUnknown: z.boolean().optional(),
              })
              .safeParse(metadata);
            r.threadId = usage.success ? usage.data.threadId : r.threadId;
            r.tokens =
              (r.tokens ?? 0) + (usage.success ? (usage.data.tokens ?? 0) : 0);
            r.usageUnknown ||=
              !usage.success ||
              usage.data.tokens === undefined ||
              !!usage.data.usageUnknown;
          }
          if (r.authGeneration)
            await this.device.invalidate(r.input.workspaceId, r.authGeneration);
          r.state = "auth_required";
          r.error = "coding_device_auth_required";
          r.authPausedAt = Date.now();
          await this.save(r);
          await this.removeAuthVolume(r);
          return;
        }
        await this.captureAuth(r);
      }
      if (state.ExitCode !== 0 && r.phase === "check" && r.input.development) {
        if (!this.canImplement(r)) return;
        r.repairs = (r.repairs ?? 0) + 1; // Reserve before the repair launch.
        await this.engine.command([
          "rm",
          "--force",
          "--ignore",
          `${r.key}-implement`,
          `${r.key}-check`,
        ]);
        r.phase = "implement";
        await this.save(r);
        await this.launch(
          r,
          "implement",
          r.input.payload.authMode === "provider_key"
            ? { CODEX_TASK_TOKEN: r.proxyToken }
            : {},
        );
        return;
      }
      if (state.ExitCode !== 0) {
        r.state = r.phase === "publish" ? "unknown" : "failed";
        r.error =
          r.phase === "publish"
            ? "coding_publication_unknown"
            : "coding_execution_failed";
        if (r.phase === "publish" && r.input.development) {
          try {
            r.publishedSha = z
              .object({ publishedSha: z.string().regex(/^[0-9a-f]{40}$/) })
              .parse(
                JSON.parse(await this.copyResult(r, "publication-intent.json")),
              ).publishedSha;
          } catch {}
          try {
            if (
              (await this.copyResult(r, "failure-code")).trim() ===
              "coding_remote_head_changed"
            ) {
              r.state = "failed";
              r.error = "coding_remote_head_changed";
            }
          } catch {}
        }
        if (
          r.phase === "implement" ||
          r.phase === "check" ||
          r.phase === "setup"
        ) {
          if (r.phase === "implement" && r.input.development) {
            const failure = z
              .object({
                code: z.enum(conversationFailureCodes),
                threadId: z
                  .string()
                  .regex(/^[a-zA-Z0-9-]{1,100}$/)
                  .optional(),
                tokens: z.number().int().nonnegative().optional(),
                usageUnknown: z.boolean().optional(),
                resultIssues: resultIssues.optional(),
              })
              .safeParse(
                await this.copyResult(r, "conversation-failure.json")
                  .then((text) => JSON.parse(text))
                  .catch(() => null),
              );
            if (failure.success) {
              r.error = failure.data.code;
              r.threadId = failure.data.threadId ?? r.threadId;
              r.tokens = (r.tokens ?? 0) + (failure.data.tokens ?? 0);
              r.usageUnknown ||=
                failure.data.tokens === undefined ||
                !!failure.data.usageUnknown;
              r.resultIssues = failure.data.resultIssues;
            }
          }
          try {
            const id = (await this.copyResult(r, "thread-id")).trim();
            if (/^[a-zA-Z0-9-]{1,100}$/.test(id)) r.threadId = id;
          } catch {
            // Codex may have failed before starting a thread.
          }
          try {
            const code = (await this.copyResult(r, "failure-code")).trim();
            if (implementationFailures.has(code)) r.error = code;
          } catch {
            // Keep the generic failure when no safe stage marker exists.
          }
        }
      } else if (r.phase === "prepare") {
        r.baseSha = z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .parse((await this.copyResult(r, "base-sha")).trim());
        r.phase = "setup";
        r.state = "running";
        await this.save(r);
        await this.launch(r, "setup");
      } else if (r.phase === "setup") {
        if (!this.canImplement(r)) return;
        r.phase = "implement";
        await this.save(r);
        await this.launch(
          r,
          "implement",
          r.input.payload.authMode === "provider_key"
            ? { CODEX_TASK_TOKEN: r.proxyToken }
            : {},
        );
      } else if (r.phase === "implement") {
        const conversation = r.input.development
          ? await this.engine.readText(
              `${r.key}-implement`,
              "/task/conversation.json",
              developmentResultByteLimit,
            )
          : undefined;
        if (!r.input.development && !r.verificationCommands) {
          try {
            r.verificationCommands = verificationCommands.parse(
              JSON.parse(
                await this.engine.readText(
                  `${r.key}-implement`,
                  "/task/verification.json",
                  20000,
                ),
              ),
            );
          } catch {
            r.state = "failed";
            r.error = "coding_verification_invalid";
            await this.removeAuthVolume(r);
            await this.save(r);
            return;
          }
        }
        await this.removeAuthVolume(r);
        if (r.input.development) {
          let value: unknown;
          try {
            value = JSON.parse(conversation ?? "null");
          } catch {
            value = null;
          }
          const parsed = z
            .object({
              result: developmentResult,
              tokens: z.number().int().nonnegative(),
              usageUnknown: z.boolean().optional(),
              resultIssues: resultIssues.optional(),
              threadId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
            })
            .safeParse(value);
          if (!parsed.success) {
            r.state = "failed";
            r.error = "coding_result_invalid";
            r.resultIssues = safeResultIssues(
              parsed.error.issues.map((issue) => ({
                ...issue,
                path: issue.path[0] === "result" ? issue.path.slice(1) : [],
              })),
            );
            await this.save(r);
            return;
          }
          const turn = parsed.data;
          r.result = turn.result;
          r.threadId = turn.threadId;
          r.tokens = (r.tokens ?? 0) + turn.tokens;
          r.usageUnknown ||= turn.usageUnknown;
          r.resultIssues = turn.resultIssues;
          await writeFile(this.path(r, "conversation"), JSON.stringify(turn), {
            mode: 0o600,
          });
          await this.exportArtifact(r);
          if (
            r.input.development.mode !== "work" ||
            turn.result.status === "needs_input"
          ) {
            r.state = "succeeded";
            await this.save(r);
            return;
          }
          requireThat(
            turn.result.status === "completed",
            "coding_result_invalid",
            409,
          );
          // Repairs rerun the initial plan; subsequent model output cannot weaken it.
          r.verificationCommands ??= verificationCommands.parse(
            turn.result.verificationCommands,
          );
          r.result.verificationCommands = r.verificationCommands;
        }
        r.phase = "check";
        await this.save(r);
        await this.launch(r, "check");
      } else if (r.phase === "check") {
        await this.exportArtifact(r);
        r.checkPassed = true;
        r.state = "ready";
      } else {
        const result = z
          .object({
            prUrl: z.string().url(),
            publishedSha: z
              .string()
              .regex(/^[0-9a-f]{40}$/)
              .optional(),
          })
          .parse(JSON.parse(await this.copyResult(r, "publication.json")));
        requireThat(
          result.prUrl.startsWith(
            `https://github.com/${r.input.payload.repository}/pull/`,
          ),
          "coding_pr_missing",
        );
        r.prUrl = result.prUrl;
        r.publishedSha = result.publishedSha;
        r.state = "succeeded";
      }
      if (state.ExitCode !== 0 && r.phase === "implement")
        await this.removeAuthVolume(r);
      await this.save(r);
    } catch {
      // Reconcile engine outages on the next poll. Container names prevent duplicate starts.
      throw new Fault("coding_runner_unavailable", 503);
    }
  }
  private async exportArtifact(r: Record) {
    await this.engine.command(["rm", "--force", "--ignore", `${r.key}-export`]);
    const artifact = z
      .object({
        patch: z.string().max(5 * 1024 * 1024),
        threadId: z
          .string()
          .regex(/^[a-zA-Z0-9-]{1,100}$/)
          .optional(),
      })
      .parse(JSON.parse(await this.launch(r, "export")));
    requireThat(
      r.input.development || artifact.patch.length,
      "coding_patch_empty",
      409,
    );
    await writeFile(this.path(r, "patch"), artifact.patch, { mode: 0o600 });
    r.threadId = artifact.threadId ?? r.threadId;
  }
  async publish(workspaceId: string, taskId: string, token: string) {
    return this.serial(async () => {
      const r = this.get(workspaceId, taskId);
      if (r.phase === "publish") return;
      requireThat(r.state === "ready", "coding_task_not_ready", 409);
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
  async resumeAuth(workspaceId: string, taskId: string) {
    return this.serial(async () => {
      const r = this.get(workspaceId, taskId);
      requireThat(!r.cleaned, "coding_checkpoint_expired", 409);
      requireThat(
        r.input.payload.authMode === "device_code",
        "coding_device_mode_required",
        409,
      );
      if (r.state !== "auth_required") {
        requireThat(
          r.phase === "implement" && r.state === "running",
          "coding_task_not_ready",
          409,
        );
        return; // Repeated acknowledgements never launch a second container.
      }
      requireThat(
        this.hasCapacity() && this.canRunTask(r.input) && this.canImplement(r),
        "coding_runner_busy",
        429,
      );
      await this.device.read(workspaceId);
      await this.removeAuthVolume(r);
      r.authPausedAt = undefined;
      r.finishedAt = undefined;
      r.error = undefined;
      r.state = "running";
      await this.save(r);
      try {
        await this.launch(r, "implement");
      } catch {
        r.state = "unknown";
        r.error = "coding_outcome_unknown";
        await this.save(r);
        throw new Fault("coding_outcome_unknown", 503);
      }
    });
  }
  private async stop(r: Record) {
    if (terminal(r.state) && r.state !== "auth_required") return;
    if (
      r.state !== "auth_required" &&
      r.phase === "implement" &&
      r.input.payload.authMode === "device_code"
    ) {
      // Stop token rotation before reading the final cache; keep the container for cp.
      await this.engine.command([
        "stop",
        "--ignore",
        "--time",
        "0",
        `${r.key}-implement`,
      ]);
      try {
        await this.captureAuth(r);
      } catch {
        /* Preserve the last sealed credential. */
      }
    }
    // `rm --force --ignore` also handles a reservation that never created a container.
    await this.engine.command([
      "rm",
      "--force",
      "--ignore",
      `${r.key}-${r.phase}`,
    ]);
    if (r.phase === "implement") await this.removeAuthVolume(r);
    r.state = r.phase === "publish" ? "unknown" : "cancelled";
    await this.save(r);
  }
  async cancel(workspaceId: string, taskId: string) {
    return this.serial(() => this.stop(this.get(workspaceId, taskId)));
  }
  async erase(workspaceId: string, taskId: string) {
    return this.serial(async () => {
      const r = this.records.get(taskKey(workspaceId, taskId));
      if (!r || r.cleaned) return;
      await this.stop(r);
      await this.engine.command([
        "rm",
        "--force",
        "--ignore",
        ...[
          "prepare",
          "setup",
          "implement",
          "check",
          "export",
          "publish",
          "input",
        ].map((p) => `${r.key}-${p}`),
      ]);
      for (const volume of ["work", "publish", "auth", "input"]) {
        const names = await this.engine.command([
          "volume",
          "ls",
          "--format",
          "{{.Name}}",
          "--filter",
          `name=${r.key}-${volume}`,
        ]);
        if (names.split("\n").includes(`${r.key}-${volume}`))
          await this.engine.command([
            "volume",
            "rm",
            "--force",
            `${r.key}-${volume}`,
          ]);
      }
      for (const suffix of ["patch", "result", "input", "conversation", "auth"])
        await rm(this.path(r, suffix), { force: true });
      r.cleaned = true;
      r.proxyToken = "";
      r.result = undefined;
      r.resultIssues = undefined;
      r.verificationCommands = undefined;
      r.threadId = undefined;
      r.input.development = undefined;
      r.input.issue = undefined;
      r.input.payload.title = "[removed]";
      r.input.payload.body = "[removed]";
      r.input.payload.repository = "removed/removed";
      await this.save(r);
    });
  }
  async logoutDevice(workspaceId: string) {
    return this.serial(async () => {
      for (const r of this.records.values())
        if (
          r.input.workspaceId === workspaceId &&
          r.input.payload.authMode === "device_code" &&
          ["preparing", "running", "ready", "auth_required"].includes(r.state)
        )
          await this.stop(r);
      return this.device.logout(workspaceId);
    });
  }
  providerConnection(token: string) {
    const record = [...this.records.values()].find(
      (r) =>
        r.state === "running" &&
        r.phase === "implement" &&
        r.input.payload.authMode === "provider_key" &&
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
    return {
      apiKey: key,
      baseUrl:
        record.input.modelProvider?.baseUrl ??
        this.settings.CODEX_PROVIDER_BASE_URL,
      model: record.input.modelProvider?.model ?? this.settings.CODEX_MODEL,
    };
  }
  providerKey(token: string): string {
    return this.providerConnection(token).apiKey;
  }
  async sweep() {
    return this.serial(async () => {
      for (const r of this.records.values()) {
        if (!terminal(r.state) || r.state === "auth_required")
          await this.advance(r);
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
            ...[
              "prepare",
              "setup",
              "implement",
              "check",
              "export",
              "publish",
              "input",
            ].map((p) => `${r.key}-${p}`),
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
              (name) =>
                name === `${r.key}-work` ||
                name === `${r.key}-publish` ||
                name === `${r.key}-auth` ||
                name === `${r.key}-input`,
            );
          if (volumes.length)
            await this.engine.command(["volume", "rm", "--force", ...volumes]);
          for (const suffix of ["patch", "result", "input", "conversation"])
            await rm(this.path(r, suffix), { force: true });
          // Keep a small tombstone so delayed duplicate requests cannot replay the task.
          if (r.state === "auth_required") {
            r.state = "failed";
            r.error = "coding_checkpoint_expired";
          }
          r.cleaned = true;
          r.proxyToken = "";
          r.input.payload.body = "[expired]";
          r.input.payload.title = "[expired]";
          delete r.result;
          delete r.verificationCommands;
          if (r.input.development) {
            r.input.development.inputs = [];
            r.input.development.context = "";
            delete r.input.development.media;
          }
          await this.save(r);
        }
      }
    });
  }
}
