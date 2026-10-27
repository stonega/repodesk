import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { TSchema } from "typebox";
import { codeTruthToolCatalog } from "../../services/code-truth/src/tool-catalog.ts";
import type { BuiltinExtension } from "../agent/extensions.ts";
import { inputByteLimit } from "../agent/limits.ts";
import { requireThat } from "../domain.ts";
import type { CodeTruthClient } from "./client.ts";
import { type CodeTarget, codeTruthTools } from "./config.ts";
import { codeTruthFailureCodes } from "./failure-codes.ts";

/** Named Pi factory; authority and credentials live in a per-run closure. */
export async function codeTruthExtension(
  client: CodeTruthClient | undefined,
  workspaceId: string,
  targets: CodeTarget[],
  connectionRevision?: number,
  resolveScope?: (
    actor: string,
  ) => Promise<{ client: CodeTruthClient; targets: CodeTarget[] }>,
  reportFailure?: (runId: string, error: unknown) => void,
): Promise<BuiltinExtension> {
  const skill = await readFile("skills/repodesk-code-truth/SKILL.md", "utf8");
  return {
    id: "code-truth",
    version: "3",
    path: "<inline:code-truth>",
    tools: [...codeTruthTools],
    execution: "read-only",
    enabled: true,
    workspaces: [workspaceId],
    hash: createHash("sha256")
      .update(
        JSON.stringify({
          targets,
          skill,
          version: 3,
          catalog: codeTruthToolCatalog,
          connectionRevision,
        }),
      )
      .digest("hex"),
    toolErrorCodes: codeTruthFailureCodes,
    factory: (input) => async (pi) => {
      const signal = input.signal;
      pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\n\n${skill}`,
      }));
      for (const tool of codeTruthToolCatalog) {
        pi.registerTool({
          name: tool.name,
          label: tool.title,
          description: tool.description,
          parameters: tool.inputSchema as unknown as TSchema,
          execute: async (_id, args, callSignal) => {
            const activeSignal = callSignal
              ? AbortSignal.any([signal, callSignal])
              : signal;
            let result: Awaited<ReturnType<Client["callTool"]>>;
            try {
              activeSignal.throwIfAborted();
              const scope = resolveScope
                ? await resolveScope(input.actor)
                : { client, targets };
              requireThat(scope.client, "code_truth_unavailable", 503);
              result = await scope.client.use(
                workspaceId,
                scope.targets,
                activeSignal,
                async (mcp) => {
                  const available = await mcp.listTools(
                    {},
                    {
                      signal: activeSignal,
                      timeout: 10000,
                    },
                  );
                  requireThat(
                    available.tools.length === codeTruthToolCatalog.length &&
                      codeTruthToolCatalog.every((expected) => {
                        const actual = available.tools.find(
                          (item) => item.name === expected.name,
                        );
                        return (
                          actual &&
                          isDeepStrictEqual(
                            actual.inputSchema,
                            expected.inputSchema,
                          )
                        );
                      }),
                    "code_truth_tools_changed",
                    409,
                  );
                  return mcp.callTool(
                    {
                      name: tool.name,
                      arguments: args as Record<string, unknown>,
                    },
                    undefined,
                    { signal: activeSignal, timeout: 60000 },
                  );
                },
              );
            } catch (error) {
              try {
                reportFailure?.(input.runId, error);
              } catch {
                // Diagnostics cannot change authorization or tool outcomes.
              }
              throw error;
            }
            // MCP's short content summary omits the actual source: retain structured evidence.
            const text = JSON.stringify(
              result.structuredContent ?? result.content,
            );
            const limit = Math.max(
              1000,
              Math.min(
                24000,
                Math.floor(
                  inputByteLimit(input, {
                    contextWindow: input.model.contextWindow,
                    maxOutputTokens: input.model.maxTokens,
                  }) / 2,
                ),
              ),
            );
            const bytes = Buffer.from(text, "utf8");
            return {
              content: [
                {
                  type: "text",
                  text:
                    bytes.length <= limit
                      ? text
                      : `${new TextDecoder().decode(bytes.subarray(0, limit), { stream: true })}\n[Output truncated. Request a smaller excerpt or maxCharacters.]`,
                },
              ],
              details: {},
            };
          },
        });
      }
    },
  };
}
