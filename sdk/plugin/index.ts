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
export interface ToolResult<
  Output = JsonObject,
  Event extends string = string,
> {
  content: { type: "text"; text: string }[];
  structuredContent: Output;
  /** Candidate events; only the host may authorize and deliver subscribed events. */
  notifications?: PluginNotification<Event>[];
}
export interface PluginNotification<Event extends string = string> {
  occurredAt: string;
  event: Event;
  id: string;
  title: string;
  body: string;
  url?: string;
}
export type ToolContracts = Record<
  string,
  { input: JsonObject; output: JsonObject }
>;
export type PluginDefinition<
  C extends ToolContracts,
  S,
  Event extends string = string,
> = {
  tools: {
    [Name in keyof C]: (
      input: C[Name]["input"],
      context: ToolContext<S>,
    ) => Promise<ToolResult<C[Name]["output"], Event>>;
  };
};

/** Preview author SDK. The host supplies an invocation-bound context. */
export function definePlugin<
  C extends ToolContracts,
  S = Record<string, never>,
  Event extends string = string,
>(definition: PluginDefinition<C, S, Event>): PluginDefinition<C, S, Event> {
  return definition;
}
