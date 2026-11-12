import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
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
/** Upgrade only the unchanged, application-owned original; pins stay immutable. */
function upgradeTelegramWidgetSkill(skill: Workspace["skills"][number]) {
  const description =
    "Create interactive charts, comparisons and calculators inside private Telegram messages.";
  const body =
    "Read [the rendering guide](references/rendering.md) with load_skill and this skill's id before creating a widget. Follow its limits and example; send HTML and a useful caption with send_telegram_widget.";
  if (!skill.preset || skill.archived || skill.origin || skill.githubSource)
    return;
  if (skill.draft.description !== description || skill.draft.body !== body)
    return;
  const spec = telegramWidgetSpec();
  const original = { ...spec, description, body };
  if (
    !isDeepStrictEqual(skill.draft, original) ||
    !isDeepStrictEqual(skill.published.at(-1), original)
  )
    return;
  skill.draft = spec;
  skill.published.push(structuredClone(spec));
  skill.version++;
}

/** Existing tenants get the preset and approved updates while preserving disablement. */
export function ensureTelegramWidgetSkill(w: Workspace) {
  if (w.deletion) return;
  const existing = w.skills.find((s) => s.draft.slug === "telegram-widgets");
  if (existing) {
    upgradeTelegramWidgetSkill(existing);
    return;
  }
  if (w.skills.length >= 100) return;
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
