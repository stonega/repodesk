import { posix } from "node:path";
import { z } from "zod";
import { operator } from "../admin/auth.ts";
import type { PluginRecord } from "../agent/plugin-config.ts";
import type { Store } from "../db/repositories.ts";
import {
  type Admin,
  type Run,
  requireThat,
  type Workspace,
} from "../domain.ts";
import { fingerprint } from "../setup/credentials.ts";
import { audit, eligible, runAllowed } from "../workspaces/policy.ts";
import { exportVault } from "./archive.ts";
import {
  type ObsidianPage,
  obsidianTools,
  vaultLimits,
  vaultMutation,
  vaultPath,
  vaultQuery,
} from "./config.ts";
import {
  applyTemplate,
  obsidianEnabled,
  obsidianGeneration,
  renameFile,
  summaries,
  validateVault,
  vaultFor,
} from "./vault.ts";

export function authorizeVault(admin: Admin, w: Workspace) {
  operator(admin);
  requireThat(w.operatorId === admin.id && !w.deletion, "access_denied", 403);
}
export function queryVault(w: Workspace, value: unknown = {}) {
  const input = vaultQuery.parse(value);
  const query = input.query.toLowerCase();
  const vault = vaultFor(w);
  const matches = summaries(vault.files)
    .filter((note) => {
      const file = vault.files.find((f) => f.path === note.path);
      return (
        !!note.trashed === input.trash &&
        (!query ||
          [note.path, note.title, ...note.aliases, file?.content ?? ""].some(
            (s) => s.toLowerCase().includes(query),
          )) &&
        (!input.folder ||
          note.path.startsWith(`${input.folder.replace(/\/$/, "")}/`)) &&
        (!input.tag ||
          note.tags.some(
            (t) => t === input.tag || t.startsWith(`${input.tag}/`),
          )) &&
        (!input.property ||
          (Object.hasOwn(note.properties, input.property) &&
            (input.value === undefined ||
              String(note.properties[input.property]) === input.value))) &&
        (!input.tasks ||
          note.tasks.some((t) => t.done === (input.tasks === "done")))
      );
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    vaultRevision: vault.revision,
    files: matches.slice(input.offset, input.offset + input.limit),
    total: matches.length,
    ...(matches.length > input.offset + input.limit
      ? { nextOffset: input.offset + input.limit }
      : {}),
  };
}
export function mutateVault(
  w: Workspace,
  actor: string,
  value: unknown,
  receiptId?: string,
  now = new Date(),
) {
  const input = vaultMutation.parse(value);
  const hash = fingerprint(input);
  const vault = structuredClone(vaultFor(w));
  const previous = receiptId
    ? vault.receipts.find((r) => r.id === receiptId)
    : undefined;
  if (previous) {
    requireThat(previous.hash === hash, "obsidian_duplicate_conflict", 409);
    return { revision: previous.revision, path: previous.path };
  }
  requireThat(vault.revision === input.revision, "version_conflict", 409);
  const at = now.toISOString();
  let path: string | undefined;
  const save = (target: string, content: string, createOnly = false) => {
    const existing = vault.files.find((f) => f.path === target);
    requireThat(
      !existing?.trashed && (!createOnly || !existing),
      "obsidian_path_exists",
      409,
    );
    if (existing) {
      existing.content = content;
      existing.version++;
      existing.updatedAt = at;
    } else
      vault.files.push({ path: target, content, version: 1, updatedAt: at });
    path = target;
  };
  if (input.action === "save") save(input.path, input.content);
  if (input.action === "import") {
    requireThat(
      new Set(input.files.map((f) => f.path.toLowerCase())).size ===
        input.files.length,
      "obsidian_path_exists",
      409,
    );
    for (const file of input.files)
      save(file.path, file.content, !input.overwrite);
  }
  if (input.action === "rename") {
    renameFile(vault, input.path, input.destination, at);
    path = input.destination;
  }
  if (input.action === "trash" || input.action === "restore") {
    const file = vault.files.find((f) => f.path === input.path);
    requireThat(
      file && !!file.trashed === (input.action === "restore"),
      "not_found",
      404,
    );
    file.trashed = input.action === "trash";
    file.version++;
    file.updatedAt = at;
    path = input.path;
  }
  if (input.action === "template" || input.action === "daily") {
    const target =
      input.action === "daily" ? `Daily/${input.date}.md` : input.path;
    requireThat(target.endsWith(".md"), "obsidian_markdown_required", 400);
    const template = vault.files.find(
      (f) =>
        !f.trashed &&
        f.path ===
          (input.action === "daily" ? "Templates/Daily.md" : input.template),
    );
    requireThat(template, "obsidian_template_missing", 404);
    requireThat(
      template.path.endsWith(".md"),
      "obsidian_markdown_required",
      400,
    );
    const text = applyTemplate(
      template.content,
      posix.basename(target, ".md"),
      input.date,
      input.action === "daily" ? "00:00" : input.time,
    );
    if (input.action === "daily") {
      const existing = vault.files.find((f) => f.path === target && !f.trashed);
      save(
        target,
        `${existing?.content ?? text}${input.content ? `\n${input.content}\n` : ""}`,
      );
    } else save(target, text, true);
  }
  validateVault(vault);
  vault.revision++;
  if (receiptId)
    vault.receipts = [
      ...vault.receipts,
      { id: receiptId, hash, revision: vault.revision, path },
    ].slice(-200);
  w.obsidian = vault;
  audit(
    w,
    actor,
    `obsidian.${input.action}`,
    "organization-vault",
    vault.revision,
    now,
  );
  return { revision: vault.revision, path };
}

export class ObsidianService {
  constructor(private store: Store) {}
  async view(
    admin: Admin,
    id: string,
    query: unknown = {},
  ): Promise<ObsidianPage> {
    const w = await this.store.read(id);
    authorizeVault(admin, w);
    return {
      revision: w.plugins?.revision ?? 0,
      settings: {
        enabled: obsidianEnabled(w),
        generation: obsidianGeneration(w),
      },
      ...queryVault(w, query),
      limits: vaultLimits,
    };
  }
  async configure(
    admin: Admin,
    id: string,
    value: unknown,
    entries?: PluginRecord[],
  ) {
    const input = z
      .object({
        revision: z.number().int().nonnegative(),
        enabled: z.boolean(),
      })
      .strict()
      .parse(value);
    await this.store.change(id, (w) => {
      authorizeVault(admin, w);
      requireThat(
        (w.plugins?.revision ?? 0) === input.revision,
        "version_conflict",
        409,
      );
      requireThat(
        !input.enabled ||
          !(w.plugins?.entries ?? entries ?? []).some(
            (e) =>
              e.enabled &&
              e.tools.some((name) =>
                (obsidianTools as readonly string[]).includes(name),
              ),
          ),
        "extension_tool_collision",
        409,
      );
      w.plugins = {
        ...w.plugins,
        revision: input.revision + 1,
        entries: w.plugins?.entries ?? entries ?? [],
        obsidian: {
          enabled: input.enabled,
          generation: obsidianGeneration(w) + 1,
        },
      };
      audit(
        w,
        admin.id,
        "obsidian.configured",
        "organization-vault",
        w.plugins.revision,
      );
    });
    return this.view(admin, id);
  }
  async read(admin: Admin, id: string, path: string) {
    const w = await this.store.read(id);
    authorizeVault(admin, w);
    return this.file(w, path);
  }
  private file(w: Workspace, path: string) {
    vaultPath.parse(path);
    const vault = vaultFor(w);
    const file = vault.files.find((f) => f.path === path);
    requireThat(file, "not_found", 404);
    return {
      ...file,
      vaultRevision: vault.revision,
      summary: summaries(vault.files).find((n) => n.path === path),
    };
  }
  async mutate(admin: Admin, id: string, value: unknown) {
    return this.store.change(id, (w) => {
      authorizeVault(admin, w);
      return mutateVault(w, admin.id, value);
    });
  }
  async export(admin: Admin, id: string) {
    const w = await this.store.read(id);
    authorizeVault(admin, w);
    return exportVault(vaultFor(w));
  }
  async tool(
    id: string,
    runId: string,
    actor: string,
    generation: number,
    fence: number,
    action: "query" | "read" | "write",
    value: unknown,
    callId: string,
    signal?: AbortSignal,
  ) {
    return this.store.change(id, (w) => {
      signal?.throwIfAborted();
      const run = w.runs.find((r) => r.id === runId);
      requireThat(
        run &&
          run.actor === actor &&
          run.status === "running" &&
          run.fence === fence &&
          runAllowed(w, run) &&
          eligible(w, actor) &&
          obsidianEnabled(w) &&
          obsidianGeneration(w) === generation,
        "access_denied",
        403,
      );
      if (action === "write")
        requireThat(!run.workflowId, "access_denied", 403);
      run.obsidianRead = { generation };
      if (action === "write")
        return mutateVault(w, actor, value, `${runId}:${callId}`);
      if (action === "query") return queryVault(w, value);
      const input = z.object({ path: vaultPath }).strict().parse(value);
      const file = this.file(w, input.path);
      requireThat(!file.trashed, "not_found", 404);
      return file;
    });
  }
  async executionFence(id: string, runId: string): Promise<Run["fence"]> {
    const w = await this.store.read(id);
    const run = w.runs.find((r) => r.id === runId);
    requireThat(run, "access_denied", 403);
    return run.fence;
  }
}
