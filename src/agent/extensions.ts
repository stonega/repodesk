import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  type BeforeAgentStartEventResult,
  DefaultResourceLoader,
  type ExtensionContext,
  type ExtensionEvent,
  type ExtensionFactory,
  type LoadExtensionsResult,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Fault, requireThat } from "../domain.ts";
import {
  type PluginRecord,
  type PluginSpec,
  pluginManifestSchema,
} from "./plugin-config.ts";
import type { AgentInput } from "./runtime.ts";

type Entry = PluginSpec & { hash: string };
export type BuiltinExtension = Entry & {
  factory: (input: AgentInput) => ExtensionFactory;
};
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const supportedEvents = new Set([
  "session_start",
  "session_shutdown",
  "before_agent_start",
  "context",
  "agent_start",
  "agent_end",
  "tool_call",
  "tool_result",
]);
const unsupported = () => {
  throw new Fault("extension_api_unsupported", 409);
};

/** Explicit local files only. No home-directory discovery or package installation. */
export class ExtensionCatalog {
  readonly version: string;
  private constructor(
    private entries: Entry[],
    private builtins: BuiltinExtension[] = [],
  ) {
    this.version = digest(
      JSON.stringify([
        ...entries,
        ...builtins.map(({ factory: _, ...entry }) => entry),
      ]),
    );
  }
  static async load(manifestPath: string) {
    try {
      const file = resolve(manifestPath);
      return ExtensionCatalog.fromSnapshot(
        await ExtensionCatalog.fromManifest(
          JSON.parse(await readFile(file, "utf8")),
          dirname(file),
        ),
      );
    } catch {
      throw new Fault("extension_configuration_invalid", 409);
    }
  }
  static async fromManifest(value: unknown, baseDir = process.cwd()) {
    try {
      const manifest = pluginManifestSchema.parse(value);
      const ids = new Set<string>();
      const paths = new Set<string>();
      const entries: PluginRecord[] = [];
      for (const entry of manifest) {
        requireThat(
          isAbsolute(entry.path) ||
            entry.path.startsWith("./") ||
            entry.path.startsWith("../"),
          "extension_path_invalid",
        );
        let path = resolve(baseDir, entry.path);
        requireThat(/\.(ts|js|mjs)$/.test(path), "extension_path_invalid");
        let hash: string | undefined;
        if (entry.enabled) {
          path = await realpath(path);
          requireThat(
            /\.(ts|js|mjs)$/.test(path) && (await stat(path)).isFile(),
            "extension_path_invalid",
          );
          hash = digest(await readFile(path));
        }
        requireThat(
          !ids.has(entry.id) && !paths.has(path),
          "extension_duplicate",
        );
        requireThat(
          new Set(entry.tools).size === entry.tools.length,
          "extension_duplicate",
        );
        ids.add(entry.id);
        paths.add(path);
        entries.push({ ...entry, path, hash });
      }
      return entries;
    } catch {
      throw new Fault("extension_configuration_invalid", 409);
    }
  }
  static fromSnapshot(
    entries: PluginRecord[],
    builtins: BuiltinExtension[] = [],
  ) {
    return new ExtensionCatalog(
      entries
        .filter((entry) => entry.enabled)
        .map((entry) => {
          requireThat(entry.hash, "extension_configuration_invalid", 409);
          return { ...entry, hash: entry.hash };
        }),
      builtins,
    );
  }
  static async fileStatus(entry: PluginRecord) {
    if (!entry.enabled) return "unchecked" as const;
    try {
      return digest(await readFile(entry.path)) === entry.hash
        ? ("ready" as const)
        : ("changed" as const);
    } catch {
      return "unavailable" as const;
    }
  }
  snapshot(): PluginRecord[] {
    return structuredClone(this.entries);
  }
  async open(input: AgentInput): Promise<ExtensionHost | undefined> {
    const entries = [...this.entries, ...this.builtins].filter(
      (entry) =>
        input.workspaceId && entry.workspaces.includes(input.workspaceId),
    );
    if (!entries.length) return undefined;
    await input.guard();
    input.signal.throwIfAborted();
    const cwd = await mkdtemp(join(tmpdir(), "repodesk-extension-"));
    let loaded: LoadExtensionsResult | undefined;
    try {
      for (const entry of entries.filter(
        (item) => !this.builtins.includes(item as BuiltinExtension),
      ))
        requireThat(
          digest(await readFile(entry.path)) === entry.hash,
          "extension_changed",
          409,
        );
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: join(cwd, "agent"),
        settingsManager: SettingsManager.inMemory(),
        additionalExtensionPaths: entries
          .filter((entry) => !this.builtins.includes(entry as BuiltinExtension))
          .map((entry) => entry.path),
        extensionFactories: this.builtins
          .filter((entry) => entries.includes(entry))
          .map((entry) => ({ name: entry.id, factory: entry.factory(input) })),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      loaded = loader.getExtensions();
      requireThat(
        !loaded.errors.length && loaded.extensions.length === entries.length,
        "extension_load_failed",
        409,
      );
      return new ExtensionHost(loaded, entries, cwd, input);
    } catch (error) {
      loaded?.runtime.invalidate();
      await rm(cwd, { recursive: true, force: true });
      if (error instanceof Fault) throw error;
      throw new Fault("extension_load_failed", 409);
    }
  }
}

/** Pi's real loader/API registrations, adapted to the application's durable run. */
export class ExtensionHost {
  readonly tools: AgentTool[] = [];
  private context: ExtensionContext;
  private system: string;
  private closed = false;
  private running = false;
  constructor(
    private loaded: LoadExtensionsResult,
    entries: Entry[],
    private cwd: string,
    private input: AgentInput,
  ) {
    this.system = input.system;
    this.context = {
      hasUI: false,
      mode: "print",
      cwd,
      model: structuredClone(input.model),
      scopedModels: [],
      thinkingLevel: input.thinkingLevel ?? "off",
      signal: input.signal,
      isIdle: () => !this.running,
      isProjectTrusted: () => true,
      hasPendingMessages: () => false,
      getContextUsage: () => undefined,
      getSystemPrompt: () => this.system,
      get ui() {
        return unsupported();
      },
      get sessionManager() {
        return unsupported();
      },
      get modelRegistry() {
        return unsupported();
      },
      abort: unsupported,
      shutdown: unsupported,
      compact: unsupported,
    };
    const names = new Set(input.tools.map((tool) => tool.name));
    for (const extension of loaded.extensions) {
      const entry = entries.find(
        (item) => item.path === extension.resolvedPath,
      );
      requireThat(entry, "extension_load_failed", 409);
      requireThat(
        !extension.commands.size && !extension.shortcuts.size,
        "extension_api_unsupported",
        409,
      );
      for (const event of extension.handlers.keys())
        requireThat(
          supportedEvents.has(event),
          "extension_event_unsupported",
          409,
        );
      for (const { definition } of extension.tools.values()) {
        requireThat(
          !names.has(definition.name),
          "extension_tool_collision",
          409,
        );
        requireThat(
          entry.tools.includes(definition.name),
          "extension_tool_not_granted",
          403,
        );
        names.add(definition.name);
        this.tools.push({
          name: definition.name,
          label: definition.label,
          description: definition.description,
          parameters: definition.parameters,
          prepareArguments: definition.prepareArguments
            ? (args) => {
                try {
                  return definition.prepareArguments?.(args);
                } catch {
                  throw new Fault("extension_tool_failed", 409);
                }
              }
            : undefined,
          executionMode: "sequential",
          replay: "never",
          execute: async (callId, args, signal, onUpdate) => {
            const execute = async (): Promise<AgentToolResult<unknown>> => {
              try {
                signal?.throwIfAborted();
                await input.guard();
                const result = await definition.execute(
                  callId,
                  args,
                  signal,
                  onUpdate,
                  this.context,
                );
                signal?.throwIfAborted();
                await input.guard();
                return result;
              } catch {
                // Pi turns thrown tool errors into model-visible messages.
                throw new Fault("extension_tool_failed", 409);
              }
            };
            return input.extensionTool
              ? input.extensionTool(definition.name, callId, execute)
              : execute();
          },
        });
      }
    }
    requireThat(
      !loaded.runtime.pendingProviderRegistrations.length &&
        !loaded.runtime.pendingNativeProviderRegistrations.length,
      "extension_api_unsupported",
      409,
    );
    const allTools = [...input.tools, ...this.tools];
    Object.assign(loaded.runtime, {
      getActiveTools: () => allTools.map((tool) => tool.name),
      getAllTools: () =>
        allTools.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      getThinkingLevel: () => input.thinkingLevel ?? "off",
      refreshTools: unsupported,
    });
  }
  async emit(
    event: ExtensionEvent,
    apply?: (result: unknown) => void,
  ): Promise<unknown[]> {
    if (event.type === "agent_start") this.running = true;
    if (event.type === "agent_end" || event.type === "session_shutdown")
      this.running = false;
    const results: unknown[] = [];
    for (const extension of this.loaded.extensions) {
      for (const handler of extension.handlers.get(event.type) ?? []) {
        try {
          if (event.type !== "session_shutdown") {
            this.input.signal.throwIfAborted();
            await this.input.guard();
          }
          const result: unknown = await handler(event, this.context);
          results.push(result);
          apply?.(result);
        } catch {
          throw new Fault("extension_hook_failed", 409);
        }
      }
    }
    return results;
  }
  async start() {
    await this.emit({ type: "session_start", reason: "startup" });
    // Chain prompt replacements in extension registration order, as Pi does.
    for (const extension of this.loaded.extensions)
      for (const handler of extension.handlers.get("before_agent_start") ??
        []) {
        try {
          await this.input.guard();
          this.input.signal.throwIfAborted();
          const result = (await handler(
            {
              type: "before_agent_start",
              prompt: this.input.prompt,
              systemPrompt: this.system,
              systemPromptOptions: {
                cwd: this.cwd,
                customPrompt: this.input.system,
                selectedTools: [...this.input.tools, ...this.tools].map(
                  (t) => t.name,
                ),
              },
            },
            this.context,
          )) as BeforeAgentStartEventResult | undefined;
          requireThat(!result?.message, "extension_api_unsupported", 409);
          if (result?.systemPrompt !== undefined) {
            requireThat(
              typeof result.systemPrompt === "string",
              "extension_hook_failed",
            );
            this.system = result.systemPrompt;
          }
        } catch {
          throw new Fault("extension_hook_failed", 409);
        }
      }
    return this.system;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      this.loaded.runtime.invalidate();
      await rm(this.cwd, { recursive: true, force: true });
    }
  }
}
