import { posix } from "node:path";
import { Marked } from "marked";

const markdown = new Marked();

/** Only local Markdown/text links inside the skill directory become resources. */
export function skillResourcePaths(body: string, from = "SKILL.md") {
  const paths = new Set<string>();
  markdown.walkTokens(markdown.lexer(body), (token) => {
    if (token.type !== "link") return;
    let href: string;
    try {
      href = decodeURIComponent(token.href.split("#")[0] ?? "");
    } catch {
      return;
    }
    if (
      !/\.(md|txt)$/i.test(href) ||
      /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(href) ||
      /[\\?]/.test(href) ||
      Array.from(href).some((char) => char.charCodeAt(0) < 32)
    )
      return;
    const path = posix.normalize(posix.join(posix.dirname(from), href));
    if (path !== ".." && !path.startsWith("../") && path !== "SKILL.md")
      paths.add(path);
  });
  return [...paths];
}
