import { strToU8, zipSync } from "fflate";
import type { VaultState } from "./config.ts";

/** Only application-owned settings; never load executable community plugins. */
export function exportVault(vault: VaultState) {
  const files: Record<string, Uint8Array> = Object.create(null);
  for (const file of vault.files)
    if (!file.trashed) files[file.path] = strToU8(file.content);
  const settings = {
    "core-plugins": [
      "file-explorer",
      "global-search",
      "switcher",
      "graph",
      "backlink",
      "canvas",
      "outgoing-link",
      "tag-pane",
      "properties",
      "page-preview",
      "daily-notes",
      "templates",
      "note-composer",
      "command-palette",
      "bookmarks",
      "outline",
      "word-count",
      "file-recovery",
      "bases",
    ],
    "daily-notes": {
      folder: "Daily",
      template: "Templates/Daily",
      format: "YYYY-MM-DD",
    },
    templates: {
      folder: "Templates",
      dateFormat: "YYYY-MM-DD",
      timeFormat: "HH:mm",
    },
    app: {
      alwaysUpdateLinks: true,
      newLinkFormat: "absolute",
      useMarkdownLinks: false,
      attachmentFolderPath: "Attachments",
    },
  };
  for (const [name, value] of Object.entries(settings))
    files[`.obsidian/${name}.json`] = strToU8(JSON.stringify(value, null, 2));
  return zipSync(files, { level: 6 });
}
