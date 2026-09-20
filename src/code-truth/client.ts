import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Fault } from "../domain.ts";
import type { CodeTarget, CodeTruthStatus } from "./config.ts";

export class CodeTruthClient {
  constructor(
    private url: string,
    private token: string,
    private github?: () => Promise<{ token: string | null; identity: string }>,
  ) {}
  withGitHub(
    github: () => Promise<{ token: string | null; identity: string }>,
  ) {
    return new CodeTruthClient(this.url, this.token, github);
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
    const { namespace } = await this.configure(workspaceId, targets, signal);
    if (!/^[a-f0-9]{64}$/.test(namespace))
      throw new Fault("code_truth_unavailable", 503);
    const client = new Client({ name: "deepx-agent", version: "1" });
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
    } catch {
      throw new Fault("code_truth_unavailable", 503);
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}
