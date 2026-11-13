import { definePlugin } from "@repodesk/plugin-sdk";
import type { Contract, Settings } from "./generated/contract.ts";

export default definePlugin<Contract, Settings>({
  tools: {
    async repository_summary({ repositoryId }, context) {
      context.signal.throwIfAborted();
      const data = await context.github.getRepository({ repositoryId });
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
      };
    },
  },
});
