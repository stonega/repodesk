import { z } from "zod";
import { Fault, requireThat } from "../domain.ts";
import { nowledgeUrl } from "./config.ts";

export const remoteMemory = z.object({
  id: z.string().min(1).max(200),
  space_id: z.string().max(200),
  title: z.string().max(1000).nullish(),
  content: z.string().max(32768),
});
export class NowledgeClient {
  constructor(private transport: typeof fetch = fetch) {}
  async request(
    apiUrl: string,
    apiKey: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    nowledgeUrl.parse(apiUrl);
    const deadline = AbortSignal.any([
      AbortSignal.timeout(15000),
      ...(signal ? [signal] : []),
    ]);
    try {
      deadline.throwIfAborted();
      const response = await this.transport(
        `${apiUrl.replace(/\/$/, "")}${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "error",
          signal: deadline,
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Fault(
          [401, 403].includes(response.status)
            ? "nowledge_mem_access_denied"
            : response.status === 429
              ? "nowledge_mem_rate_limited"
              : "nowledge_mem_unavailable",
          502,
        );
      }
      requireThat(response.body, "nowledge_mem_invalid_response", 502);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          deadline.throwIfAborted();
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          requireThat(
            size <= 512 * 1024,
            "nowledge_mem_response_too_large",
            502,
          );
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof Fault) throw error;
      throw new Fault("nowledge_mem_unavailable", 503);
    }
  }
  async spaces(url: string, key: string, signal?: AbortSignal) {
    const result = z
      .object({
        spaces: z
          .array(
            z.object({
              id: z.string().min(1).max(200),
              name: z.string().min(1).max(200),
            }),
          )
          .max(500),
      })
      .safeParse(await this.request(url, key, "/spaces", undefined, signal));
    requireThat(result.success, "nowledge_mem_invalid_response", 502);
    return result.data.spaces;
  }
}
