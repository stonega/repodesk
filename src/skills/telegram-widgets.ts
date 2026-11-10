import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { skillSchema, type Workspace } from "../domain.ts";

// The build copies these bundled instructions beside backend entrypoints.
const markdown = readFileSync(
  new URL("./telegram-widgets/SKILL.md", import.meta.url),
  "utf8",
);
const rendering = readFileSync(
  new URL("./telegram-widgets/references/rendering.md", import.meta.url),
  "utf8",
);
export function telegramWidgetSpec() {
  const [, header = "", body = ""] =
    /^---\n([\s\S]+?)\n---\n([\s\S]+)$/.exec(markdown) ?? [];
  const metadata = parse(header);
  return skillSchema.parse({
    slug: metadata.name,
    name: "Telegram widgets",
    description: metadata.description,
    body: body.trim(),
    tools: metadata["allowed-tools"].split(/\s+/),
    settings: { sections: "Follow the user's requested format", maxWords: 400 },
    resources: [{ path: "references/rendering.md", body: rendering }],
  });
}
/** Existing tenants get the new preset once; disabled records and slug collisions win. */
export function ensureTelegramWidgetSkill(w: Workspace) {
  if (
    w.deletion ||
    w.skills.length >= 100 ||
    w.skills.some((s) => s.draft.slug === "telegram-widgets")
  )
    return;
  const spec = telegramWidgetSpec();
  const hash = createHash("sha256")
    .update(`repodesk:telegram-widgets:${w.id}`)
    .digest("hex");
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  w.skills.push({
    id,
    preset: true,
    version: 1,
    enabled: true,
    archived: false,
    published: [spec],
    draft: spec,
    tests: [],
  });
}
