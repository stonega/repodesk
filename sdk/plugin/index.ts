export type Json = null | boolean | number | string | Json[] | JsonObject;
export type JsonObject = { [key: string]: Json };
export interface RepositorySummary {
  url: string;
  stars: number;
  forks: number;
  subscribers: number;
  fetchedAt: string;
}
export interface ToolContext<Settings = JsonObject> {
  readonly signal: AbortSignal;
  readonly settings: Readonly<Settings>;
  readonly invocation: Readonly<{ id: string; deadline: string }>;
  readonly github: {
    getRepository(input: { repositoryId: number }): Promise<RepositorySummary>;
  };
  readonly http: {
    request(
      connection: string,
      input: { path: string; query?: Record<string, string> },
    ): Promise<{ status: number; data: Json }>;
  };
  readonly diagnostics: { emit(code: string): void };
}
export interface ToolResult<Output = JsonObject> {
  content: { type: "text"; text: string }[];
  structuredContent: Output;
}
export type ToolContracts = Record<
  string,
  { input: JsonObject; output: JsonObject }
>;
export type PluginDefinition<C extends ToolContracts, S> = {
  tools: {
    [Name in keyof C]: (
      input: C[Name]["input"],
      context: ToolContext<S>,
    ) => Promise<ToolResult<C[Name]["output"]>>;
  };
};

/** Preview author SDK. The host supplies an invocation-bound context. */
export function definePlugin<
  C extends ToolContracts,
  S = Record<string, never>,
>(definition: PluginDefinition<C, S>): PluginDefinition<C, S> {
  return definition;
}
