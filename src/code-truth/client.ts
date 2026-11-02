import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Fault } from "../domain.ts";
import type { CodeTarget, CodeTruthStatus } from "./config.ts";

export class CodeTruthClient {
  constructor(
    private url: string,
    private token: string,
    private github?: () => Promise<{ token: string | null; identity: string }>,
    private indexWaitMs = 20_000,
  ) {}
  withGitHub(
    github: () => Promise<{ token: string | null; identity: string }>,
  ) {
    return new CodeTruthClient(this.url, this.token, github, this.indexWaitMs);
  }
  async configure(
    workspaceId: string,
    targets: CodeTarget[],
    signal?: AbortSignal,
  ): Promise<CodeTruthStatus & { namespace: string }> {
    try {
      const response = await fetch(new URL("/configure", this.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workspaceId,
          targets,
          ...(this.github ? { github: await this.github() } : {}),
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("unavailable");
      return (await response.json()) as CodeTruthStatus & { namespace: string };
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault("code_truth_unavailable", 503);
    }
  }
  async use<T>(
    workspaceId: string,
    targets: CodeTarget[],
    signal: AbortSignal,
    action: (client: Client) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    const deadline = Date.now() + this.indexWaitMs;
    let status = await this.configure(workspaceId, targets, signal);
    // A new/evicted namespace starts an asynchronous sync even with disk snapshots.
    // Do not present that transient empty manager as a failed repository.
    while (
      status.syncing &&
      status.targets.some((target) =>
        target.networks.some((network) => network.status !== "ready"),
      )
    ) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Fault("code_truth_indexing", 503);
      await delay(Math.min(250, remaining), undefined, { signal });
      status = await this.configure(workspaceId, targets, signal);
    }
    signal.throwIfAborted();
    const { namespace } = status;
    if (!/^[a-f0-9]{64}$/.test(namespace))
      throw new Fault("code_truth_unavailable", 503);
    const client = new Client({ name: "repodesk", version: "1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`/mcp/${namespace}`, this.url),
      {
        requestInit: {
          headers: { authorization: `Bearer ${this.token}` },
          redirect: "error",
        },
        fetch: (url, options) =>
          fetch(url, {
            ...options,
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(60000),
              ...(options?.signal ? [options.signal] : []),
            ]),
          }),
      },
    );
    try {
      await client.connect(transport);
      return await action(client);
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault("code_truth_unavailable", 503);
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}
