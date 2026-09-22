import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { TSchema } from "typebox";
import type { BuiltinExtension } from "../agent/extensions.ts";
import { inputByteLimit } from "../agent/limits.ts";
import { requireThat } from "../domain.ts";
import type { CodeTruthClient } from "./client.ts";
import { type CodeTarget, codeTruthTools } from "./config.ts";

/** Named Pi factory; authority and credentials live in a per-run closure. */
export async function codeTruthExtension(
  client: CodeTruthClient,
  workspaceId: string,
  targets: CodeTarget[],
  connectionRevision?: number,
): Promise<BuiltinExtension> {
  const skill = await readFile("skills/deepx-code-truth/SKILL.md", "utf8");
  return {
    id: "code-truth",
    version: "1",
    path: "<inline:code-truth>",
    tools: [...codeTruthTools],
    execution: "read-only",
    enabled: true,
    workspaces: [workspaceId],
    hash: createHash("sha256")
      .update(
        JSON.stringify({ targets, skill, version: 1, connectionRevision }),
      )
      .digest("hex"),
    factory: (input) => async (pi) => {
      const signal = input.signal;
      const available = await client.use(workspaceId, targets, signal, (mcp) =>
        mcp.listTools({}, { signal, timeout: 10000 }),
      );
      requireThat(
        available.tools.length === codeTruthTools.length &&
          codeTruthTools.every((name) =>
            available.tools.some((tool) => tool.name === name),
          ),
        "code_truth_tools_changed",
        409,
      );
      pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\n\n${skill}`,
      }));
      for (const tool of available.tools) {
        pi.registerTool({
          name: tool.name,
          label: tool.title ?? tool.name,
          description: tool.description ?? tool.name,
          parameters: tool.inputSchema as TSchema,
          execute: async (_id, args, callSignal) => {
            const activeSignal = callSignal
              ? AbortSignal.any([signal, callSignal])
              : signal;
            const result = await client.use(
              workspaceId,
              targets,
              activeSignal,
              (mcp) =>
                mcp.callTool(
                  {
                    name: tool.name,
                    arguments: args as Record<string, unknown>,
                  },
                  undefined,
                  { signal: activeSignal, timeout: 60000 },
                ),
            );
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
