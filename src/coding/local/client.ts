import { Fault } from "../../domain.ts";
import {
  deviceAuthStatus,
  type LocalDeviceAuth,
  type LocalRunner,
  type LocalStart,
  localStatus,
} from "./protocol.ts";

export class LocalRunnerClient implements LocalRunner, LocalDeviceAuth {
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
          error.error === "coding_token_limit"
        )
          throw new Fault(error.error, 409);
      }
      if (response.status === 503 && path.includes("/device-auth/")) {
        const error = (await response.json()) as { error?: string };
        if (error.error === "coding_device_login_unavailable")
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
  async status(workspaceId: string, taskId: string) {
    return localStatus.parse(
      await this.request(this.path(workspaceId, taskId)),
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
}
