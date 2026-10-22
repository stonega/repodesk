import { describe, expect, test } from "bun:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { exportVault } from "../../src/obsidian/archive.ts";
import { vaultPath } from "../../src/obsidian/config.ts";
import { importArchive } from "../../src/obsidian/import.ts";
import { mutateVault, queryVault } from "../../src/obsidian/service.ts";
import {
  applyTemplate,
  initialVault,
  obsidianEnabled,
  validateFile,
  vaultFor,
} from "../../src/obsidian/vault.ts";
import { sweep } from "../../src/privacy/service.ts";
import { completedSkillSource } from "../../src/skills/proposals.ts";
import { runAllowed } from "../../src/workspaces/policy.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { retainedSource } from "../../src/workspaces/threads.ts";
import { workspace } from "../fixtures.ts";

const save = (w: ReturnType<typeof workspace>, path: string, content: string) =>
  mutateVault(w, "101", {
    action: "save",
    revision: vaultFor(w).revision,
    path,
    content,
  });
describe("managed Obsidian vault", () => {
  test("disablement invalidates derived answers, retained history and skill extraction", () => {
    const w = workspace();
    const origin = createRun(w, "101", "Read notes", "101", 1, "fixture");
    origin.obsidianRead = { generation: 0 };
    origin.status = "succeeded";
    origin.result = "Shared notes";
    const answer = {
      id: "notes-answer",
      runId: origin.id,
      role: "assistant" as const,
      threadId: origin.threadId,
      chatId: "101",
      topicId: 1,
      author: "101",
      text: "Shared notes",
      at: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      directed: true,
    };
    w.messages.push(answer);
    const derived = createRun(w, "101", "Summarize that", "101", 1, "fixture");
    derived.status = "succeeded";
    derived.result = "Derived answer";
    expect(retainedSource(w, answer)).toBe(true);
    expect(derived.sources.some((s) => s.id === answer.id)).toBe(true);
    expect(runAllowed(w, derived)).toBe(true);
    w.plugins = {
      revision: 1,
      entries: [],
      obsidian: { enabled: false, generation: 1 },
    };
    expect(retainedSource(w, answer)).toBe(false);
    expect(runAllowed(w, derived)).toBe(false);
    expect(() =>
      completedSkillSource(w, "101", "101", 0, derived.id),
    ).toThrow();
    w.plugins.obsidian = { enabled: true, generation: 2 };
    expect(retainedSource(w, answer)).toBe(false);
    expect(runAllowed(w, derived)).toBe(false);
  });
  test("existing and new workspaces get independent enabled native vaults without a migration", () => {
    const a = workspace();
    const b = workspace();
    expect(obsidianEnabled(a)).toBe(true);
    expect(a.obsidian).toBeUndefined();
    expect(initialVault().files).toHaveLength(5);
    for (const file of initialVault().files) validateFile(file);
    save(a, "Decisions/Launch.md", "# Launch");
    expect(queryVault(b).total).toBe(5);
    expect(queryVault(a).total).toBe(6);
  });
  test("properties, aliases, nested tags, tasks, headings, embeds and backlinks are searchable", () => {
    const w = workspace();
    save(
      w,
      "Projects/Launch.md",
      "---\naliases: [Ship]\ntags: [project/launch]\nstatus: open\n---\n# Launch\n\n#team\n- [ ] Release\n- [x] Review\n## Plan\n^decision\n",
    );
    save(
      w,
      "Meetings/Standup.md",
      "# Standup\n[[Projects/Launch#Plan|release]]\n![[Projects/Launch#^decision]]\n[launch](../Projects/Launch.md)\n`[[Missing]]`\n```md\n[[Not a link]]\n```\n",
    );
    const note = queryVault(w, {
      query: "Ship",
      tag: "project",
      property: "status",
      value: "open",
      tasks: "open",
      folder: "Projects",
    }).files[0];
    expect(note?.title).toBe("Launch");
    expect(note?.tags).toEqual(["project/launch", "team"]);
    expect(note?.tasks.map((t) => t.done)).toEqual([false, true]);
    expect(note?.backlinks).toEqual(["Meetings/Standup.md"]);
    expect(note?.headings).toEqual([
      { level: 1, text: "Launch" },
      { level: 2, text: "Plan" },
    ]);
    const meeting = queryVault(w, { query: "Standup" }).files[0];
    expect(meeting?.links).toHaveLength(3);
    expect(
      meeting?.links.every((l) => l.resolved === "Projects/Launch.md"),
    ).toBe(true);
  });
  test("ambiguous short links remain unresolved and aliases remain literal data", () => {
    const w = workspace();
    save(w, "A/Plan.md", "# A");
    save(w, "B/Plan.md", "# B");
    save(w, "Index.md", "[[Plan]]\n[[A/Plan|preferred]]");
    const links = queryVault(w, { query: "Index.md" }).files[0]?.links;
    expect(links?.[0]?.resolved).toBeUndefined();
    expect(links?.[1]?.resolved).toBe("A/Plan.md");
  });
  test("Markdown links prefer their note folder when a vault-root name also matches", () => {
    const w = workspace();
    save(w, "Projects/Home.md", "# Project home");
    save(w, "Projects/Plan.md", "# Plan\n[Local](Home.md)\n[[Home]]");
    const links = queryVault(w, { query: "Projects/Plan.md" }).files[0]?.links;
    expect(links?.[0]?.resolved).toBe("Projects/Home.md");
    expect(links?.[1]?.resolved).toBe("Home.md");
    mutateVault(w, "101", {
      action: "rename",
      path: "Projects/Plan.md",
      destination: "Archive/Plan.md",
      revision: vaultFor(w).revision,
    });
    expect(
      vaultFor(w).files.find((f) => f.path === "Archive/Plan.md")?.content,
    ).toContain("[Local](../Projects/Home.md)");
  });
  test("rename updates resolved wikilinks, heading/block suffixes, Markdown links and Canvas nodes", () => {
    const w = workspace();
    save(w, "Projects/Launch.md", "# Launch\n[[Home]]");
    save(
      w,
      "Index.md",
      "[[Projects/Launch#Plan|launch]]\n![[Projects/Launch#^id]]\n[launch](Projects/Launch.md)\n`[[Projects/Launch]]`",
    );
    save(
      w,
      "Map.canvas",
      JSON.stringify({
        nodes: [
          {
            id: "a",
            type: "file",
            file: "Projects/Launch.md",
            x: 0,
            y: 0,
            width: 200,
            height: 200,
          },
        ],
        edges: [],
      }),
    );
    mutateVault(w, "101", {
      action: "rename",
      revision: vaultFor(w).revision,
      path: "Projects/Launch.md",
      destination: "Archived/Launch.md",
    });
    expect(vaultFor(w).files.find((f) => f.path === "Index.md")?.content).toBe(
      "[[Archived/Launch#Plan|launch]]\n![[Archived/Launch#^id]]\n[launch](Archived/Launch.md)\n`[[Projects/Launch]]`",
    );
    expect(
      vaultFor(w).files.find((f) => f.path === "Map.canvas")?.content,
    ).toContain("Archived/Launch.md");
    expect(
      queryVault(w, { query: "Archived/Launch.md" }).files[0]?.backlinks,
    ).toEqual(["Index.md", "Map.canvas"]);
  });
  test("revisions protect concurrent edits and failed validation leaves all files unchanged", () => {
    const w = workspace();
    save(w, "Note.md", "Original");
    const before = structuredClone(w);
    expect(() =>
      mutateVault(w, "101", {
        action: "save",
        revision: 0,
        path: "Note.md",
        content: "Stale",
      }),
    ).toThrow();
    expect(() =>
      mutateVault(w, "101", {
        action: "import",
        revision: 1,
        overwrite: true,
        files: [
          { path: "Note.md", content: "Changed" },
          { path: "Bad.base", content: "views: nope" },
        ],
      }),
    ).toThrow();
    expect(w).toEqual(before);
  });
  test("duplicate mutations never append twice and mismatched duplicate payloads fail", () => {
    const w = workspace();
    const input = {
      action: "daily",
      date: "2026-10-22",
      revision: 0,
      content: "Decision",
    };
    const result = mutateVault(w, "101", input, "run:call");
    expect(mutateVault(w, "101", input, "run:call")).toEqual(result);
    expect(
      vaultFor(w)
        .files.find((f) => f.path === "Daily/2026-10-22.md")
        ?.content.match(/Decision/g),
    ).toHaveLength(2); // heading plus one appended entry
    expect(
      w.audit.filter((entry) => entry.action === "obsidian.daily"),
    ).toHaveLength(1);
    expect(() =>
      mutateVault(w, "101", { ...input, content: "Different" }, "run:call"),
    ).toThrow();
  });
  test("daily notes append and templates substitute supported native variables", () => {
    const w = workspace();
    mutateVault(w, "101", {
      action: "daily",
      date: "2026-10-22",
      revision: 0,
      content: "First",
    });
    mutateVault(w, "101", {
      action: "daily",
      date: "2026-10-22",
      revision: 1,
      content: "Second",
    });
    const daily = vaultFor(w).files.find(
      (f) => f.path === "Daily/2026-10-22.md",
    );
    expect(daily?.content).toContain('date: "2026-10-22"');
    expect(daily?.content).toContain("First\n\nSecond");
    mutateVault(w, "101", {
      action: "template",
      path: "Meetings/Planning.md",
      template: "Templates/Meeting.md",
      date: "2026-10-22",
      time: "09:30",
      revision: 2,
    });
    expect(
      vaultFor(w).files.find((f) => f.path === "Meetings/Planning.md")?.content,
    ).toContain("# Planning");
    expect(
      applyTemplate(
        "{{title}} {{date:YYYY/MM/DD}} {{time:HH:mm}}",
        "Plan",
        "2026-10-22",
        "09:30",
      ),
    ).toBe("Plan 2026/10/22 09:30");
    expect(() =>
      applyTemplate("{{date:MMMM}}", "Plan", "2026-10-22", "09:30"),
    ).toThrow();
  });
  test("trash is excluded from search/export, retains capacity and can be restored", () => {
    const w = workspace();
    mutateVault(w, "101", { action: "trash", path: "Home.md", revision: 0 });
    expect(
      queryVault(w, { query: "Home.md" }).files.some(
        (f) => f.path === "Home.md",
      ),
    ).toBe(false);
    expect(queryVault(w, { trash: true }).files[0]?.path).toBe("Home.md");
    expect(unzipSync(exportVault(vaultFor(w)))["Home.md"]).toBeUndefined();
    mutateVault(w, "101", { action: "restore", path: "Home.md", revision: 1 });
    expect(
      queryVault(w, { query: "Home.md" }).files.some(
        (f) => f.path === "Home.md",
      ),
    ).toBe(true);
  });
  test("pagination discloses remaining matches and filters don't drop content", () => {
    const w = workspace();
    const first = queryVault(w, { limit: 2 });
    expect(first.files).toHaveLength(2);
    expect(first.nextOffset).toBe(2);
    expect(first.total).toBe(5);
    expect(queryVault(w, { limit: 2, offset: 4 }).nextOffset).toBeUndefined();
  });
  test("rejects traversal, absolute/hidden paths, invalid types, duplicate paths and large UTF-8 files", () => {
    for (const path of [
      "../Secret.md",
      "CON.md",
      "A/LPT1.md",
      "/Secret.md",
      "A/../Secret.md",
      "A\\Secret.md",
      ".obsidian/plugins.md",
      "a.exe",
      "a\0.md",
      "A//b.md",
      "A/b .md",
      "a#b.md",
    ]) {
      if (path === "A/b .md") continue; // Internal spaces are legitimate portable names.
      expect(vaultPath.safeParse(path).success).toBe(false);
    }
    const w = workspace();
    expect(() => save(w, "home.md", "Duplicate")).toThrow();
    expect(() => save(w, "Large.md", "界".repeat(40000))).toThrow();
    expect(() => save(w, "Bad.md", "---\na: [\n---\ntext")).toThrow();
    expect(w.obsidian).toBeUndefined();
  });
  test("native Canvas and Bases validate structure while preserving formulas as data", () => {
    const w = workspace();
    save(
      w,
      "Tasks.base",
      'filters: file.hasTag("task")\nformulas:\n  sample: "status == \'open\'"\nviews:\n  - type: table\n    name: Tasks\n',
    );
    expect(
      vaultFor(w).files.find((f) => f.path === "Tasks.base")?.content,
    ).toContain("formulas:");
    for (const content of [
      "null",
      "{}",
      '{"nodes":[{"id":"x","type":"file","file":"../Secret.md","x":0,"y":0,"width":1,"height":1}],"edges":[]}',
      '{"nodes":[],"edges":[{"id":"x","fromNode":"missing","toNode":"missing"}]}',
    ])
      expect(() => save(w, "Bad.canvas", content)).toThrow();
  });
  test("ZIP export/import preserves native text and skips settings, executables and binaries", () => {
    const vault = initialVault();
    const zip = exportVault(vault);
    const exported = unzipSync(zip);
    expect(
      JSON.parse(
        strFromU8(exported[".obsidian/daily-notes.json"] ?? new Uint8Array()),
      ).folder,
    ).toBe("Daily");
    const imported = importArchive(zip);
    expect(imported.files).toHaveLength(5);
    expect(imported.skipped).toHaveLength(4);
    for (const file of vault.files)
      expect(imported.files.find((f) => f.path === file.path)?.content).toBe(
        file.content,
      );
    const custom = importArchive(
      zipSync({
        "你好.md": strToU8("# 你好"),
        "plugin.js": strToU8("throw Error()"),
        "image.png": new Uint8Array([1, 2]),
      }),
    );
    expect(custom.files).toEqual([{ path: "你好.md", content: "# 你好" }]);
    expect(custom.skipped).toHaveLength(2);
    expect(() =>
      importArchive(zipSync({ "Big.md": strToU8("a".repeat(100001)) })),
    ).toThrow();
  });
  test("import collisions need explicit replacement and don't silently revive Trash", () => {
    const w = workspace();
    const files = [{ path: "Home.md", content: "Replacement" }];
    expect(() =>
      mutateVault(w, "101", { action: "import", revision: 0, files }),
    ).toThrow();
    mutateVault(w, "101", {
      action: "import",
      revision: 0,
      files,
      overwrite: true,
    });
    expect(vaultFor(w).files.find((f) => f.path === "Home.md")?.content).toBe(
      "Replacement",
    );
    mutateVault(w, "101", { action: "trash", revision: 1, path: "Home.md" });
    expect(() =>
      mutateVault(w, "101", {
        action: "import",
        revision: 2,
        files,
        overwrite: true,
      }),
    ).toThrow();
  });
  test("disable/re-enable fences retained evidence and workspace purge removes notes", () => {
    const w = workspace();
    const run = createRun(
      w,
      "101",
      "Read organization notes",
      "101",
      0,
      "fixture",
    );
    run.obsidianRead = { generation: 0 };
    expect(runAllowed(w, run)).toBe(true);
    w.plugins = {
      revision: 1,
      entries: [],
      obsidian: { enabled: false, generation: 1 },
    };
    expect(runAllowed(w, run)).toBe(false);
    w.plugins.obsidian = { enabled: true, generation: 2 };
    expect(runAllowed(w, run)).toBe(false);
    save(w, "Note.md", "Shared");
    w.deletion = {
      requestedAt: new Date().toISOString(),
      providerState: "pending",
    };
    sweep(w);
    expect(w.obsidian).toBeUndefined();
  });
});
