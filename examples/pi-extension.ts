import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// This file also runs unchanged in Pi's coding-agent harness.
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "count_words",
    label: "Count words",
    description:
      "Count whitespace-separated words in supplied text. No external I/O.",
    parameters: Type.Object({ text: Type.String({ maxLength: 12000 }) }),
    async execute(_id, params) {
      const count = params.text.trim().split(/\s+/).filter(Boolean).length;
      return { content: [{ type: "text", text: String(count) }], details: {} };
    },
  });
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\nUse count_words when an exact word count helps.`,
  }));
}
