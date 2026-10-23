import { spawn } from "node:child_process";
import { join } from "node:path";
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
  constructor(
    private python = process.env.QWEN_ASR_PYTHON ?? "python3",
    private directory = process.env.QWEN_ASR_DIRECTORY ??
      join(process.cwd(), "data/qwen-asr"),
    private script = fileURLToPath(new URL("./qwen-asr.py", import.meta.url)),
  ) {}
  private run(action: string, signal: AbortSignal, bytes?: Uint8Array) {
    signal.throwIfAborted();
    return new Promise<unknown>((resolve, reject) => {
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
      let output = "";
      let failed = false;
      const abort = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
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
  async transcribe(bytes: Uint8Array, signal: AbortSignal) {
    const result = transcript.safeParse(
      await this.run("transcribe", signal, bytes),
    );
    if (!result.success) throw new Fault("audio_transcription_failed", 503);
    return result.data.text;
  }
}
export const qwenRuntime = new QwenRuntime();
