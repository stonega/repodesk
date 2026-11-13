import { definePlugin } from "@repodesk/plugin-sdk";
import type { Contract, Settings } from "./generated/contract.ts";

export default definePlugin<Contract, Settings>({
  tools: {
    async count_words({ text }, context) {
      context.signal.throwIfAborted();
      const count = text.trim().split(/\s+/).filter(Boolean).length;
      return {
        content: [{ type: "text", text: String(count) }],
        structuredContent: { count },
      };
    },
  },
});
