import { request } from "node:http";
import { z } from "zod";
import { Fault, requireThat } from "../domain.ts";
import { browserLimits } from "./config.ts";
import {
  type HostRequest,
  type HostResult,
  hostResult,
  signBrowserRequest,
} from "./protocol.ts";

export type BrowserInvocation = Omit<
  HostRequest,
  "id" | "issuedAt" | "expiresAt"
>;
export interface BrowserHost {
  invoke(input: BrowserInvocation, signal?: AbortSignal): Promise<HostResult>;
}
const remoteFault = z
  .object({ error: z.string().regex(/^browser_[a-z_]+$/) })
  .strict();
const knownFaults = new Set([
  "browser_busy",
  "browser_control_expired",
  "browser_input_pending",
  "browser_destination_denied",
  "browser_page_changed",
  "browser_outcome_unknown",
  "browser_capacity",
  "browser_display_unavailable",
  "browser_field_unavailable",
  "browser_action_approval_required",
  "browser_sensitive_field",
  "browser_private_result",
  "browser_artifact_unavailable",
  "browser_page_unavailable",
  "browser_operation_timeout",
  "browser_host_system_unavailable",
  "browser_host_cleanup_failed",
  "browser_profile_invalid",
  "browser_credentials_unavailable",
  "browser_launch_failed",
  "browser_protocol_unavailable",
]);

/** Private Unix socket only: the browser management interface is never public. */
export class BrowserHostClient implements BrowserHost {
  constructor(
    private socketPath: string,
    private key: string | (() => Promise<string>),
  ) {}
  async invoke(
    input: BrowserInvocation,
    signal?: AbortSignal,
  ): Promise<HostResult> {
    signal?.throwIfAborted();
    requireThat(
      this.socketPath.startsWith("/"),
      "browser_service_unavailable",
      503,
    );
    let key: string;
    try {
      key = typeof this.key === "function" ? await this.key() : this.key;
    } catch {
      throw new Fault("browser_credentials_unavailable", 503);
    }
    signal?.throwIfAborted();
    const signed = signBrowserRequest(key, input);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path: "/v1/browser",
          method: "POST",
          agent: false,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(signed.body),
            "x-repodesk-browser-signature": signed.signature,
          },
          signal,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (
              size >
              (input.operation.command === "artifact"
                ? 36 * 1024 * 1024
                : 128 * 1024)
            ) {
              req.destroy();
              reject(new Fault("browser_service_unavailable", 503));
            } else chunks.push(chunk);
          });
          response.on("error", () =>
            reject(new Fault("browser_service_unavailable", 503)),
          );
          response.on("end", () => {
            try {
              const data: unknown = JSON.parse(
                Buffer.concat(chunks).toString("utf8"),
              );
              if (response.statusCode !== 200) {
                const fault = remoteFault.safeParse(data);
                const known =
                  fault.success && knownFaults.has(fault.data.error);
                throw new Fault(
                  known ? fault.data.error : "browser_service_unavailable",
                  known &&
                    [400, 401, 403, 404, 409, 413, 503, 504].includes(
                      response.statusCode ?? 0,
                    )
                    ? response.statusCode
                    : 503,
                );
              }
              resolve(hostResult.parse(data));
            } catch (error) {
              reject(
                error instanceof Fault
                  ? error
                  : new Fault("browser_service_unavailable", 503),
              );
            }
          });
        },
      );
      req.setTimeout(browserLimits.operationMs, () => req.destroy());
      req.on("error", () =>
        reject(new Fault("browser_service_unavailable", 503)),
      );
      req.end(signed.body);
    });
  }
}
