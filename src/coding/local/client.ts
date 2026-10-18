import { Fault } from "../../domain.ts";
import type { TaskMessage } from "../conversation.ts";
import {
  type LocalRuntimeControl,
  type RuntimeSave,
  runtimeView,
} from "../runtime-config.ts";
import {
  deviceAuthStatus,
  type LocalDeviceAuth,
  type LocalRunner,
  type LocalStart,
  localStatus,
} from "./protocol.ts";

export class LocalRunnerClient
  implements LocalRunner, LocalDeviceAuth, LocalRuntimeControl
{
  constructor(
    private url: string,
    private token: string,
    private transport: typeof fetch = fetch,
  ) {}
  private async request(path: string, body?: unknown) {
    try {
      const response = await this.transport(`${this.url}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(90000),
      });
      if (response.status === 404 && path.startsWith("/tasks/"))
        throw new Fault("coding_task_not_found", 404);
      if (path === "/runtime" && !response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        if (
          response.status === 409 &&
          [
            "coding_runtime_in_use",
            "coding_runtime_not_configured",
            "coding_runtime_version_conflict",
          ].includes(data.error ?? "")
        )
          throw new Fault(data.error as string, 409);
        if (
          response.status === 503 &&
          data.error === "coding_runtime_unavailable"
        )
          throw new Fault(data.error, 503);
        if (response.status === 404)
          throw new Fault("coding_runtime_control_unavailable", 503);
      }
      if (response.status === 429)
        throw new Fault(
          path.includes("/device-auth/")
            ? "coding_device_login_busy"
            : "coding_runner_busy",
          429,
        );
      if (response.status === 409) {
        const error = (await response.json()) as { error?: string };
        if (
          error.error === "coding_provider_not_configured" ||
          error.error === "coding_device_auth_required" ||
          error.error === "coding_device_mode_required" ||
          error.error === "coding_checkpoint_expired" ||
          error.error === "coding_token_limit" ||
          error.error === "coding_message_conflict" ||
          error.error === "coding_message_closed"
        )
          throw new Fault(error.error, 409);
      }
      if (response.status === 503 && path.includes("/device-auth/")) {
        const error = (await response.json()) as { error?: string };
        if (
          error.error &&
          [
            "coding_device_login_unavailable",
            "coding_device_login_network_failed",
            "coding_device_login_rejected",
            "coding_device_login_disabled",
          ].includes(error.error)
        )
          throw new Fault(error.error, 503);
      }
      if (!response.ok)
        throw new Fault(
          body === undefined
            ? "coding_runner_unavailable"
            : "coding_outcome_unknown",
          503,
        );
      return await response.json();
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault(
        body === undefined
          ? "coding_runner_unavailable"
          : "coding_outcome_unknown",
        503,
      );
    }
  }
  private path(workspaceId: string, taskId: string) {
    return `/tasks/${encodeURIComponent(workspaceId)}/${encodeURIComponent(taskId)}`;
  }
  async start(input: LocalStart) {
    await this.request("/tasks", input);
  }
  async message(workspaceId: string, taskId: string, input: TaskMessage) {
    await this.request(`${this.path(workspaceId, taskId)}/messages`, input);
  }
  async status(workspaceId: string, taskId: string, transcriptOffset = 0) {
    return localStatus.parse(
      await this.request(
        `${this.path(workspaceId, taskId)}${transcriptOffset ? `?transcriptOffset=${transcriptOffset}` : ""}`,
      ),
    );
  }
  async publish(workspaceId: string, taskId: string, token: string) {
    await this.request(`${this.path(workspaceId, taskId)}/publish`, { token });
  }
  async resumeAuth(workspaceId: string, taskId: string) {
    await this.request(`${this.path(workspaceId, taskId)}/resume-auth`, {});
  }
  async erase(workspaceId: string, taskId: string) {
    await this.request(`${this.path(workspaceId, taskId)}/erase`, {});
  }
  async cancel(workspaceId: string, taskId: string) {
    await this.request(`${this.path(workspaceId, taskId)}/cancel`, {});
  }
  private devicePath(workspaceId: string) {
    return `/device-auth/${encodeURIComponent(workspaceId)}`;
  }
  async deviceStatus(workspaceId: string) {
    return deviceAuthStatus.parse(
      await this.request(this.devicePath(workspaceId)),
    );
  }
  async deviceStart(workspaceId: string) {
    return deviceAuthStatus.parse(
      await this.request(`${this.devicePath(workspaceId)}/start`, {}),
    );
  }
  async deviceLogout(workspaceId: string) {
    return deviceAuthStatus.parse(
      await this.request(`${this.devicePath(workspaceId)}/logout`, {}),
    );
  }
  async runtimeStatus() {
    return runtimeView.parse(await this.request("/runtime"));
  }
  async runtimeSave(input: RuntimeSave) {
    return runtimeView.parse(await this.request("/runtime", input));
  }
}
