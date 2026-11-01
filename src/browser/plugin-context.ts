import type { BrowserAction } from "./config.ts";

/** Present only inside an explicitly granted file-plugin tool invocation. */
export interface BrowserPluginContext {
  browser?: {
    action(input: BrowserAction): Promise<unknown>;
    session(input: {
      action: "status" | "acquire" | "release" | "close";
    }): Promise<unknown>;
  };
}
