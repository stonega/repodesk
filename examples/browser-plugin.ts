import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BrowserPluginContext } from "../src/browser/plugin-context.ts";

// Install as a reviewed file plugin and explicitly grant Browser access.
// One broker operation per tool call preserves its durable pause/resume binding.
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "open_private_site",
    label: "Open my private site",
    description:
      "Open a website in the actor's own headed browser. Site consent is requested on Browser.",
    parameters: Type.Object(
      { url: Type.String({ maxLength: 2048 }) },
      { additionalProperties: false },
    ),
    async execute(_callId, args, _signal, _update, context) {
      const browser = (context as typeof context & BrowserPluginContext)
        .browser;
      const result = browser
        ? await browser.action({ action: "navigate", url: args.url })
        : { status: "unavailable", code: "browser_permission_required" };
      // Return a waiting receipt immediately. The application resumes this exact call.
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: {},
      };
    },
  });
}
