import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  assertJson,
  type Capability,
  type JsonObject,
  limits,
  PluginError,
  type ToolResult,
} from "./contract.ts";
import { sha256 } from "./digest.ts";
import {
  authorizeBroker,
  type Broker,
  validateInput,
  validateResult,
  validateSettings,
} from "./invocation.ts";
import { type PluginManifest, parseManifest } from "./manifest.ts";
import {
  FrameReader,
  HostSession,
  protocolVersion,
  type RpcFrame,
} from "./protocol.ts";

export interface SandboxInvocation {
  manifest: PluginManifest;
  bundle: Buffer;
  bundleHash: string;
  tool: string;
  arguments: JsonObject;
  settings: JsonObject;
  signal: AbortSignal;
  grants: readonly Capability[];
  guard: () => Promise<void>;
  broker: Broker;
  diagnostic?: (code: string) => void;
  timeoutMs?: number;
}
export interface PluginSandbox {
  invoke(input: SandboxInvocation): Promise<ToolResult>;
}

const dockerExec = promisify(execFile);
/** Reap only our expired, labelled task containers after supervisor interruption. */
export async function reapPluginSandboxes(now = Date.now()): Promise<number> {
  const { stdout } = await dockerExec(
    "docker",
    ["ps", "-aq", "--filter", "label=repodesk.plugin-sandbox=true"],
    { timeout: 5000, maxBuffer: 65536 },
  );
  const ids = stdout
    .trim()
    .split(/\s+/)
    .filter((id) => /^[a-f0-9]{12,64}$/.test(id))
    .slice(0, 64);
  let removed = 0;
  for (const id of ids) {
    const { stdout: deadline } = await dockerExec(
      "docker",
      [
        "inspect",
        "--format",
        '{{index .Config.Labels "repodesk.plugin-deadline"}}',
        id,
      ],
      { timeout: 5000, maxBuffer: 1024 },
    );
    if (/^\d+$/.test(deadline.trim()) && Number(deadline.trim()) < now) {
      await dockerExec("docker", ["rm", "-f", id], {
        timeout: 5000,
        maxBuffer: 1024,
      });
      removed++;
    }
  }
  return removed;
}

/** Trusted supervisor only. Never construct this in the ordinary app/worker. */
export class DockerPluginSandbox implements PluginSandbox {
  private active = 0;
  constructor(
    readonly image: string,
    private capacity = 4,
  ) {
    if (!/^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/.test(image))
      throw new PluginError("plugin_unavailable");
  }
  async invoke(input: SandboxInvocation): Promise<ToolResult> {
    input.signal.throwIfAborted();
    if (this.active >= this.capacity)
      throw new PluginError("plugin_unavailable");
    const manifest = parseManifest(input.manifest);
    validateInput(manifest, input.tool, input.arguments);
    const settings = validateSettings(manifest, input.settings);
    if (
      input.bundle.length > limits.bundle ||
      sha256(input.bundle) !== input.bundleHash
    )
      throw new PluginError("plugin_package_invalid");
    await input.guard();
    if (this.active >= this.capacity)
      throw new PluginError("plugin_unavailable");
    this.active++;
    const name = `repodesk-plugin-${randomUUID()}`;
    const timeout = Math.max(
      1,
      Math.min(input.timeoutMs ?? limits.deadlineMs, limits.deadlineMs),
    );
    const environment = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...(process.env.DOCKER_HOST
        ? { DOCKER_HOST: process.env.DOCKER_HOST }
        : {}),
    };
    const deadlineController = new AbortController();
    const activeSignal = AbortSignal.any([
      input.signal,
      deadlineController.signal,
    ]);
    let running: ReturnType<typeof spawn> | undefined;
    try {
      return await new Promise<ToolResult>((resolve, reject) => {
        let settled = false;
        let invoked = false;
        let stderrBytes = 0;
        const reader = new FrameReader();
        const session = new HostSession();
        const finish = (error?: PluginError, result?: ToolResult) => {
          if (settled) return;
          settled = true;
          session.close();
          clearTimeout(timer);
          input.signal.removeEventListener("abort", abort);
          if (error) reject(error);
          else if (result) resolve(result);
          else reject(new PluginError("plugin_outcome_unknown"));
        };
        const abort = () => finish(new PluginError("plugin_cancelled"));
        const timer = setTimeout(() => {
          deadlineController.abort();
          finish(new PluginError("plugin_timeout"));
        }, timeout);
        input.signal.addEventListener("abort", abort, { once: true });
        if (input.signal.aborted) {
          abort();
          return;
        }
        const child = spawn(
          "docker",
          [
            "run",
            "--rm",
            "--pull=never",
            "-i",
            "--name",
            name,
            "--label",
            "repodesk.plugin-sandbox=true",
            "--label",
            `repodesk.plugin-deadline=${Date.now() + timeout + 10000}`,
            "--network",
            "none",
            "--read-only",
            "--user",
            "1000:1000",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--memory",
            "256m",
            "--memory-swap",
            "256m",
            "--cpus",
            "1",
            "--pids-limit",
            "32",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,nodev,size=16777216",
            this.image,
          ],
          { env: environment, stdio: ["pipe", "pipe", "pipe"] },
        );
        running = child;
        const send = (frame: RpcFrame) => {
          if (!settled) child.stdin.write(`${JSON.stringify(frame)}\n`);
        };
        child.stdin.on("error", () =>
          finish(
            new PluginError(
              invoked ? "plugin_outcome_unknown" : "plugin_unavailable",
            ),
          ),
        );
        child.on("error", () => finish(new PluginError("plugin_unavailable")));
        child.on("exit", () =>
          finish(
            new PluginError(
              invoked ? "plugin_outcome_unknown" : "plugin_unavailable",
            ),
          ),
        );
        child.stderr.on("data", (chunk: Buffer) => {
          stderrBytes += chunk.length;
          if (stderrBytes > limits.frame)
            finish(new PluginError("plugin_execution_failed"));
        });
        void (async () => {
          try {
            for await (const chunk of child.stdout) {
              if (settled) break;
              for (const frame of reader.feed(chunk)) {
                if (settled) break;
                const event = session.accept(frame);
                if (event === "initialized") {
                  await input.guard();
                  session.invoke();
                  invoked = true;
                  send({
                    jsonrpc: "2.0",
                    id: "invoke",
                    method: "tool.invoke",
                    params: { tool: input.tool, arguments: input.arguments },
                  });
                } else if (event === "result" && !("method" in frame)) {
                  if ("error" in frame)
                    finish(new PluginError(frame.error.code));
                  else {
                    await input.guard();
                    input.signal.throwIfAborted();
                    finish(
                      undefined,
                      validateResult(manifest, input.tool, frame.result),
                    );
                  }
                } else if (
                  event === "broker" &&
                  "method" in frame &&
                  frame.method === "broker.request"
                ) {
                  const request = authorizeBroker(
                    manifest,
                    input.tool,
                    input.grants,
                    frame.params,
                  );
                  await input.guard();
                  input.signal.throwIfAborted();
                  try {
                    const result = await input.broker(request, activeSignal);
                    await input.guard();
                    input.signal.throwIfAborted();
                    assertJson(result, limits.result);
                    send({ jsonrpc: "2.0", id: frame.id, result });
                  } catch (error) {
                    send({
                      jsonrpc: "2.0",
                      id: frame.id,
                      error: {
                        code:
                          error instanceof PluginError
                            ? error.code
                            : "plugin_execution_failed",
                      },
                    });
                  }
                } else if (
                  event === "diagnostic" &&
                  "method" in frame &&
                  frame.method === "diagnostic.emit"
                ) {
                  if (!manifest.diagnosticCodes?.includes(frame.params.code))
                    throw new PluginError("plugin_permission_denied");
                  input.diagnostic?.(frame.params.code);
                  send({ jsonrpc: "2.0", id: frame.id, result: null });
                }
              }
            }
          } catch (error) {
            finish(
              error instanceof PluginError
                ? error
                : new PluginError("plugin_execution_failed"),
            );
          }
        })();
        send({
          jsonrpc: "2.0",
          id: "initialize",
          method: "initialize",
          params: {
            protocolVersion,
            bundle: { size: input.bundle.length, sha256: input.bundleHash },
            manifest: manifest as unknown as JsonObject,
            settings,
            invocation: {
              id: randomUUID(),
              deadline: new Date(Date.now() + timeout).toISOString(),
            },
          },
        });
        for (let offset = 0; offset < input.bundle.length; offset += 65536) {
          const end = Math.min(offset + 65536, input.bundle.length);
          send({
            jsonrpc: "2.0",
            method: "package.chunk",
            params: {
              offset,
              data: input.bundle.subarray(offset, end).toString("base64"),
              final: end === input.bundle.length,
            },
          });
        }
      });
    } finally {
      deadlineController.abort();
      // Docker removes the whole resource group, including malicious descendants.
      const cleanup = spawn("docker", ["rm", "-f", name], {
        env: environment,
        stdio: "ignore",
        signal: AbortSignal.timeout(5000),
      });
      await new Promise<void>((resolve) => {
        cleanup.on("exit", () => resolve());
        cleanup.on("error", () => resolve());
      });
      running?.kill("SIGKILL");
      this.active--;
    }
  }
}
