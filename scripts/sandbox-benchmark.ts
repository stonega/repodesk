import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { arch, availableParallelism, platform, release } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import type { LocalStart } from "../src/coding/local/protocol.ts";
import { taskRuntime } from "../src/coding/local/runtime-factory.ts";
import { runnerSettings } from "../src/coding/local/settings.ts";
import { RunnerSupervisor } from "../src/coding/local/supervisor.ts";
import type {
  TaskMode,
  TaskRuntime,
} from "../src/coding/local/task-runtime.ts";
import { runtimeEngine } from "../src/coding/runtime-config.ts";

export const benchmarkOptions = z.object({
  engines: z.array(runtimeEngine).min(1),
  iterations: z.coerce.number().int().min(1).max(100),
  concurrency: z.coerce.number().int().min(1).max(32),
  pollMs: z.coerce.number().int().min(10).max(10000),
  timeoutMs: z.coerce.number().int().min(1000).max(3600000),
  image: z
    .string()
    .min(1)
    .refine((v) => /benchmark/.test(v), "Use a dedicated benchmark image"),
  root: z.string().min(1),
  output: z.string().min(1),
});
type PhaseSample = {
  engine: string;
  iteration: number;
  slot: number;
  totalMs: number;
  phases: Partial<Record<TaskMode, number>>;
};
export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return {
    count: values.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
  };
}

export async function benchmark() {
  const options = benchmarkOptions.parse({
    engines: (
      process.env.SANDBOX_BENCHMARK_ENGINES ?? "docker,opensandbox"
    ).split(","),
    iterations: process.env.SANDBOX_BENCHMARK_ITERATIONS ?? 5,
    concurrency: process.env.SANDBOX_BENCHMARK_CONCURRENCY ?? 1,
    pollMs: process.env.SANDBOX_BENCHMARK_POLL_MS ?? 25,
    timeoutMs: process.env.SANDBOX_BENCHMARK_TIMEOUT_MS ?? 180000,
    image:
      process.env.SANDBOX_BENCHMARK_IMAGE ??
      "localhost/repodesk-sandbox-benchmark:local",
    root: resolve(
      process.env.SANDBOX_BENCHMARK_ROOT ??
        "node_modules/.cache/sandbox-benchmark",
    ),
    output: resolve(
      process.env.SANDBOX_BENCHMARK_OUTPUT ??
        "node_modules/.cache/sandbox-benchmark/results.json",
    ),
  });
  const suite = randomUUID();
  const samples: PhaseSample[] = [];
  const operations: { engine: string; operation: string; elapsedMs: number }[] =
    [];
  const failures: { engine: string; code: string }[] = [];
  const token = randomUUID().repeat(2);
  const dependencies = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ).dependencies as Record<string, string>;
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  for (const engine of options.engines) {
    const state = resolve(options.root, suite, engine);
    const settings = runnerSettings.parse({
      ...process.env,
      CODEX_CONTAINER_ENGINE: engine,
      CODEX_RUNNER_STATE: state,
      CODEX_RUNNER_TOKEN: token,
      CODEX_RUNNER_IMAGE: options.image,
      CODEX_RUNNER_CONCURRENCY: options.concurrency,
      CODEX_RUNNER_NETWORK: process.env.CODEX_RUNNER_NETWORK ?? "none",
      CODEX_PROVIDER_API_KEY: "benchmark-placeholder",
      CONTAINER_HOST:
        process.env.CONTAINER_HOST ?? "unix:///var/run/docker.sock",
      CODEX_SANDBOX_ROOT: resolve(state, "storage"),
      CODEX_SANDBOX_HOST_ROOT: resolve(state, "storage"),
    });
    let runtime: TaskRuntime;
    try {
      runtime = taskRuntime(settings);
    } catch {
      failures.push({ engine, code: "benchmark_runtime_unavailable" });
      continue;
    }
    const phaseStarts = new Map<string, number>();
    const phaseDurations = new Map<string, number>();
    const measure = async <T>(operation: string, action: () => Promise<T>) => {
      const started = performance.now();
      try {
        return await action();
      } finally {
        operations.push({
          engine,
          operation,
          elapsedMs: performance.now() - started,
        });
      }
    };
    const measured: TaskRuntime = new Proxy(runtime, {
      get(target, key) {
        if (key === "create")
          return async (...args: Parameters<TaskRuntime["create"]>) => {
            phaseStarts.set(args[0].name, performance.now());
            return measure("create", () => target.create(...args));
          };
        if (key === "inspect")
          return async (name: string) => {
            const result = await measure("inspect", () => target.inspect(name));
            if (!result.Running && !phaseDurations.has(name))
              phaseDurations.set(
                name,
                performance.now() -
                  (phaseStarts.get(name) ?? performance.now()),
              );
            return result;
          };
        if (key === "start")
          return async (name: string, attach?: boolean) => {
            const result = await measure("start", () =>
              target.start(name, attach),
            );
            if (attach)
              phaseDurations.set(
                name,
                performance.now() -
                  (phaseStarts.get(name) ?? performance.now()),
              );
            return result;
          };
        const member = Reflect.get(target, key);
        return typeof member === "function"
          ? (...args: unknown[]) =>
              measure(String(key), async () =>
                Reflect.apply(member, target, args),
              )
          : member;
      },
    });
    const supervisor = new RunnerSupervisor(settings, measured);
    const attempts: LocalStart[] = [];
    try {
      await supervisor.initialize();
      await supervisor.ready();
      for (let iteration = 0; iteration < options.iterations; iteration++) {
        const batch = await Promise.allSettled(
          Array.from({ length: options.concurrency }, async (_, slot) => {
            const input: LocalStart = {
              workspaceId: randomUUID(),
              taskId: randomUUID(),
              readToken: "benchmark-placeholder",
              development: {
                taskId: randomUUID(),
                revision: 1,
                mode: "work",
                context: "",
                inputs: [
                  {
                    revision: 1,
                    actor: "101",
                    sourceId: "source",
                    text: "Fix bug",
                    kind: "request",
                  },
                ],
              },
              payload: {
                repositoryId: 1,
                repository: "example/sandbox-benchmark",
                installationId: 1,
                githubRevision: 1,
                configRevision: 1,
                baseBranch: "main",
                title: "Sandbox benchmark fixture",
                body: "Deterministic local fixture",
                backend: "podman",
                authMode: "provider_key",
              },
            };
            attempts.push(input);
            const start = performance.now();
            await supervisor.start(input);
            let published = false;
            while (performance.now() - start < options.timeoutMs) {
              const status = await supervisor.status(
                input.workspaceId,
                input.taskId,
              );
              if (status.state === "ready" && !published) {
                published = true;
                await supervisor.publish(
                  input.workspaceId,
                  input.taskId,
                  "benchmark-placeholder",
                );
              }
              if (status.state === "succeeded") {
                const { taskKey } = await import(
                  "../src/coding/local/supervisor.ts"
                );
                const prefix = taskKey(input.workspaceId, input.taskId);
                const phases = Object.fromEntries(
                  [
                    "prepare",
                    "setup",
                    "implement",
                    "check",
                    "export",
                    "publish",
                  ].map((phase) => [
                    phase,
                    phaseDurations.get(`${prefix}-${phase}`),
                  ]),
                );
                samples.push({
                  engine,
                  iteration,
                  slot,
                  totalMs: performance.now() - start,
                  phases,
                });
                return;
              }
              if (
                ["failed", "cancelled", "unknown", "auth_required"].includes(
                  status.state,
                )
              )
                throw Error(`benchmark_${status.phase ?? "task"}_failed`);
              await new Promise((r) => setTimeout(r, options.pollMs));
            }
            throw Error("benchmark_timeout");
          }),
        );
        for (const result of batch)
          if (result.status === "rejected") throw result.reason;
      }
    } catch (error) {
      failures.push({
        engine,
        code:
          error instanceof Error && /^benchmark_[a-z_]+$/.test(error.message)
            ? error.message
            : "benchmark_runtime_unavailable",
      });
    } finally {
      let cleaned = true;
      for (const input of attempts)
        try {
          await supervisor.erase(input.workspaceId, input.taskId);
        } catch {
          cleaned = false;
          failures.push({ engine, code: "benchmark_cleanup_failed" });
        }
      if (cleaned) await rm(state, { recursive: true, force: true });
    }
  }
  const report = {
    version: 1,
    createdAt: new Date().toISOString(),
    image: options.image,
    environment: {
      node: process.version,
      platform: platform(),
      kernel: release(),
      architecture: arch(),
      availableCpus: availableParallelism(),
      bun: process.versions.bun ?? null,
      sdkVersions: {
        opensandbox: dependencies["@alibaba-group/opensandbox"],
      },
    },
    options,
    workload:
      "Credential-free simulated coding phases; no live model, GitHub, Telegram, dependency download or cold-cache eviction. Images must be preloaded. Iteration zero is the first measured run; later iterations reuse image caches, with fresh phase sandboxes.",
    summary: options.engines.map((engine) => ({
      engine,
      totalMs: distribution(
        samples.filter((s) => s.engine === engine).map((s) => s.totalMs),
      ),
      phasesMs: Object.fromEntries(
        ["prepare", "setup", "implement", "check", "export", "publish"].map(
          (phase) => [
            phase,
            distribution(
              samples
                .filter((s) => s.engine === engine)
                .flatMap((s) => {
                  const value = s.phases[phase as TaskMode];
                  return value === undefined ? [] : [value];
                }),
            ),
          ],
        ),
      ),
      operationsMs: Object.fromEntries(
        [
          ...new Set(
            operations
              .filter((s) => s.engine === engine)
              .map((s) => s.operation),
          ),
        ].map((operation) => [
          operation,
          distribution(
            operations
              .filter((s) => s.engine === engine && s.operation === operation)
              .map((s) => s.elapsedMs),
          ),
        ]),
      ),
    })),
    samples,
    operations,
    failures,
  };
  await mkdir(resolve(options.output, ".."), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify({ output: options.output, summary: report.summary.map(({ engine, totalMs }) => ({ engine, totalMs })), failures }, null, 2)}\n`,
  );
  if (failures.length) process.exitCode = 1;
  return report;
}
if (import.meta.main) await benchmark();
