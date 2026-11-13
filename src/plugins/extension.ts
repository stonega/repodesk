import type { TSchema } from "typebox";
import type { BuiltinExtension } from "../agent/extensions.ts";
import type { AgentInput } from "../agent/runtime.ts";
import { Fault } from "../domain.ts";
import { fingerprint } from "../setup/credentials.ts";
import { PluginError } from "./contract.ts";
import type { PackageInstallation } from "./package-config.ts";
import { errorCodes } from "./protocol.ts";

export const packageToolName = (repositoryId: number, localName: string) =>
  `rdp_${repositoryId}_${localName}`;
export function packageToolNames(
  installation: Pick<PackageInstallation, "source" | "manifest">,
) {
  return [
    ...installation.manifest.tools.map((t) =>
      packageToolName(installation.source.repositoryId, t.name),
    ),
    ...(installation.manifest.skills.length
      ? [packageToolName(installation.source.repositoryId, "load_guide")]
      : []),
  ];
}
export function packageExtension(
  installation: PackageInstallation,
  workspaceId: string,
  revision: number,
  runtimeIdentity: string,
  execute: (
    input: AgentInput,
    installation: PackageInstallation,
    tool: string,
    args: unknown,
    signal: AbortSignal,
  ) => Promise<{ content: { type: "text"; text: string }[]; details: unknown }>,
): BuiltinExtension {
  return {
    id: `github-${installation.source.repositoryId}`,
    version: installation.manifest.version,
    path: `<inline:github-${installation.source.repositoryId}>`,
    execution: "read-only",
    enabled: true,
    workspaces: [workspaceId],
    tools: packageToolNames(installation),
    hash: fingerprint({ installation, revision, runtimeIdentity }),
    toolErrorCodes: errorCodes,
    factory: (input) => (pi) => {
      if (installation.manifest.skills.length)
        pi.registerTool({
          name: packageToolName(installation.source.repositoryId, "load_guide"),
          label: "Load plugin guide",
          description: `Read this plugin's approved companion instructions and linked guides. Tools remain subject to current grants. Guides: ${(installation.guides ?? []).map((g) => `${g.name} (${g.path})`).join(", ")}`,
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", maxLength: 512 },
              maxCharacters: { type: "integer", minimum: 256, maximum: 16000 },
            },
            additionalProperties: false,
          } as unknown as TSchema,
          async execute(_callId, args, signal) {
            try {
              return await execute(
                input,
                installation,
                "load_guide",
                args,
                signal ? AbortSignal.any([signal, input.signal]) : input.signal,
              );
            } catch (error) {
              if (error instanceof PluginError)
                throw new Fault(error.code, 409);
              throw error;
            }
          },
        });
      for (const tool of installation.manifest.tools)
        pi.registerTool({
          name: packageToolName(installation.source.repositoryId, tool.name),
          label: tool.title,
          description: tool.description,
          parameters: tool.inputSchema as unknown as TSchema,
          async execute(_callId, args, signal) {
            try {
              return await execute(
                input,
                installation,
                tool.name,
                args,
                signal ? AbortSignal.any([signal, input.signal]) : input.signal,
              );
            } catch (error) {
              if (error instanceof PluginError)
                throw new Fault(error.code, 409);
              throw error;
            }
          },
        });
    },
  };
}
