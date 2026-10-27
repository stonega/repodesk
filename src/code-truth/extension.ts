import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { TSchema } from "typebox";
import type { BuiltinExtension } from "../agent/extensions.ts";
import { inputByteLimit } from "../agent/limits.ts";
import { Fault, requireThat } from "../domain.ts";
import type { CodeTruthClient } from "./client.ts";
import { type CodeTarget, codeTruthTools } from "./config.ts";

const unavailableCodes = [
  "code_truth_unavailable",
  "github_user_access_denied",
  "github_user_access_unavailable",
  "github_app_not_configured",
  "github_repository_not_connected",
  "github_app_permissions_missing",
  "github_access_denied",
  "github_rate_limited",
  "github_unavailable",
] as const;

/** Named Pi factory; authority and credentials live in a per-run closure. */
export async function codeTruthExtension(
  client: CodeTruthClient,
  workspaceId: string,
  targets: CodeTarget[],
  connectionRevision?: number,
  resolveScope?: (
    actor: string,
  ) => Promise<{ client: CodeTruthClient; targets: CodeTarget[] }>,
): Promise<BuiltinExtension> {
  const skill = await readFile("skills/repodesk-code-truth/SKILL.md", "utf8");
  return {
    id: "code-truth",
    version: "2",
    path: "<inline:code-truth>",
    tools: [...codeTruthTools],
    execution: "read-only",
    enabled: true,
    workspaces: [workspaceId],
    hash: createHash("sha256")
      .update(
        JSON.stringify({ targets, skill, version: 2, connectionRevision }),
      )
      .digest("hex"),
    toolErrorCodes: unavailableCodes,
    factory: (input) => async (pi) => {
      const signal = input.signal;
      const load = async () => {
        const scope = resolveScope
          ? await resolveScope(input.actor)
          : { client, targets };
        const available = await scope.client.use(
          workspaceId,
          scope.targets,
          signal,
          (mcp) => mcp.listTools({}, { signal, timeout: 10000 }),
        );
        return { scope, available };
      };
      let resources: Awaited<ReturnType<typeof load>>;
      try {
        resources = await load();
      } catch (error) {
        signal.throwIfAborted();
        if (
          !(error instanceof Fault) ||
          !unavailableCodes.some((code) => code === error.code)
        )
          throw error;
        // A repository dependency must not prevent unrelated chat. Register no
        // source tools or source skill, and expose only the fixed fault code.
        pi.on("before_agent_start", (event) => ({
          systemPrompt: `${event.systemPrompt}\n\nCode Truth repository tools are unavailable for this run (${error.code}). Do not claim to have inspected repository source. Continue unrelated requests normally. If source is needed, explain that repository access is unavailable and suggest retrying after GitHub access or the Code Truth service recovers.`,
        }));
        return;
      }
      const { scope, available } = resources;
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
            const currentScope = resolveScope
              ? await resolveScope(input.actor)
              : scope;
            const result = await currentScope.client.use(
              workspaceId,
              currentScope.targets,
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
