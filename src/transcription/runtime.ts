import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Fault } from "../domain.ts";
import { type ModelStatus, modelStatus } from "./config.ts";

export interface TranscriptionRuntime {
  status(): Promise<ModelStatus>;
  prepare(): void;
  transcribe(bytes: Uint8Array, signal: AbortSignal): Promise<string>;
}
const transcript = z.object({ text: z.string().trim().min(1).max(32000) });
const faults = new Set([
  "audio_invalid",
  "audio_too_long",
  "audio_no_speech",
  "audio_model_not_ready",
]);

/** Public model files are shared; audio is passed only through private process pipes. */
export class QwenRuntime implements TranscriptionRuntime {
  private preparing?: Promise<void>;
  private worker?: ChildProcessByStdio<Writable, Readable, null>;
  private queue = Promise.resolve();
  private idle?: ReturnType<typeof setTimeout>;
  constructor(
    private python = process.env.QWEN_ASR_PYTHON ?? "python3",
    private directory = process.env.QWEN_ASR_DIRECTORY ??
      join(process.cwd(), "data/qwen-asr"),
    private script = fileURLToPath(new URL("./qwen-asr.py", import.meta.url)),
  ) {}
  private spawn(action: string) {
    // Do not give the inference process bot, database, GitHub or model credentials.
    const env: Record<string, string> = {
      PYTHONUNBUFFERED: "1",
      HF_HUB_DISABLE_TELEMETRY: "1",
    };
    for (const key of [
      "PATH",
      "LANG",
      "SSL_CERT_FILE",
      "REQUESTS_CA_BUNDLE",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
    ])
      if (process.env[key]) env[key] = process.env[key] as string;
    const child = spawn(this.python, [this.script, action, this.directory], {
      env,
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    child.stdin.on("error", () => {});
    child.once("error", () => this.kill(child));
    child.once("close", () => {
      if (this.worker === child) this.worker = undefined;
    });
    return child;
  }
  private kill(child: NonNullable<QwenRuntime["worker"]>) {
    if (this.worker === child) this.worker = undefined;
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
  close() {
    clearTimeout(this.idle);
    if (this.worker) this.kill(this.worker);
  }
  private run(action: string, signal: AbortSignal, bytes?: Uint8Array) {
    signal.throwIfAborted();
    return new Promise<unknown>((resolve, reject) => {
      const child = this.spawn(action);
      let output = "";
      let failed = false;
      const abort = () => {
        this.kill(child);
      };
      signal.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (Buffer.byteLength(output) > 65536) {
          failed = true;
          abort();
        }
      });
      child.stdin.on("error", () => {});
      child.on("error", () => {
        signal.removeEventListener("abort", abort);
        reject(new Fault("audio_runtime_unavailable", 503));
      });
      child.on("close", (code) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) return reject(signal.reason);
        try {
          if (failed) throw new Error("output_limit");
          const value = JSON.parse(output);
          if (code !== 0 || (action === "transcribe" && value.error)) {
            throw new Fault(
              faults.has(value.error)
                ? value.error
                : "audio_transcription_failed",
              503,
            );
          }
          resolve(value);
        } catch (error) {
          reject(
            error instanceof Fault
              ? error
              : new Fault("audio_transcription_failed", 503),
          );
        }
      });
      if (signal.aborted) abort();
      child.stdin.end(bytes);
    });
  }
  async status(): Promise<ModelStatus> {
    try {
      return modelStatus.parse(
        await this.run("status", AbortSignal.timeout(10000)),
      );
    } catch {
      return { state: "unavailable" };
    }
  }
  prepare() {
    this.preparing ??= this.run("download", AbortSignal.timeout(30 * 60 * 1000))
      .then(() => {})
      .catch(() => {})
      .finally(() => {
        this.preparing = undefined;
      });
  }
  transcribe(bytes: Uint8Array, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (!bytes.length || bytes.length > 5 * 1024 * 1024)
      return Promise.reject(new Fault("audio_invalid"));
    // A cancelled waiter must not kill a different request's active inference.
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      const work = this.queue.then(() => this.request(bytes, signal));
      this.queue = work.then(
        () => {},
        () => {},
      );
      void work.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", abort);
      });
    });
  }
  private request(bytes: Uint8Array, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    clearTimeout(this.idle);
    this.worker ??= this.spawn("serve");
    const child = this.worker;
    return new Promise((resolve, reject) => {
      let output = "";
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        child.stdout.off("data", data);
        child.off("error", error);
        child.off("close", closed);
        child.stdin.off("error", error);
      };
      const fail = (reason: unknown) => {
        cleanup();
        this.kill(child);
        reject(reason);
      };
      const abort = () => fail(signal.reason);
      const error = () => fail(new Fault("audio_runtime_unavailable", 503));
      const closed = () => fail(new Fault("audio_transcription_failed", 503));
      const data = (chunk: string) => {
        output += chunk;
        if (Buffer.byteLength(output) > 65536)
          return fail(new Fault("audio_transcription_failed", 503));
        if (!output.endsWith("\n")) return;
        try {
          const value = JSON.parse(output);
          if (value.error) {
            cleanup();
            // Expected input errors leave the warm model usable.
            if (!faults.has(value.error)) this.kill(child);
            else this.release(child);
            reject(
              new Fault(
                faults.has(value.error)
                  ? value.error
                  : "audio_transcription_failed",
                503,
              ),
            );
            return;
          }
          const result = transcript.parse(value);
          cleanup();
          this.release(child);
          resolve(result.text);
        } catch {
          fail(new Fault("audio_transcription_failed", 503));
        }
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", data);
      child.once("error", error);
      child.once("close", closed);
      child.stdin.once("error", error);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) return abort();
      child.stdin.write(`${bytes.length}\n`);
      child.stdin.write(bytes);
    });
  }
  private release(child: NonNullable<QwenRuntime["worker"]>) {
    this.idle = setTimeout(() => this.kill(child), 60_000);
    this.idle.unref();
  }
}
export const qwenRuntime = new QwenRuntime();
