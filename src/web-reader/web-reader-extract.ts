import { parentPort, workerData } from "node:worker_threads";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";

// A DOM parser does not execute scripts or load subresources. Deny Defuddle's
// optional API fallbacks too: all network access belongs to the guarded reader.
const { document } = parseHTML(workerData.html);
Object.defineProperty(document, "styleSheets", { value: [] });
const result = await Defuddle(document, workerData.url, {
  markdown: true,
  useAsync: false,
  fetch: Object.assign(
    async () => {
      throw new Error("web_read_extractor_network_denied");
    },
    { preconnect() {} },
  ),
});
parentPort?.postMessage({
  title: result.title.slice(0, 500),
  description: result.description.slice(0, 1000),
  author: result.author.slice(0, 300),
  published: result.published.slice(0, 100),
  markdown: result.content.slice(0, 24000),
  truncated: result.content.length > 24000,
});
