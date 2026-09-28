import { Fault } from "../../domain.ts";
import { type LocalRunner, type LocalStart, localStatus } from "./protocol.ts";

export class LocalRunnerClient implements LocalRunner {
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
      if (response.status === 429) throw new Fault("coding_runner_busy", 429);
      if (response.status === 409) {
        const error = (await response.json()) as { error?: string };
        if (error.error === "coding_provider_not_configured")
          throw new Fault(error.error, 409);
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
  async cancel(workspaceId: string, taskId: string) {
    await this.request(`${this.path(workspaceId, taskId)}/cancel`, {});
  }
}
