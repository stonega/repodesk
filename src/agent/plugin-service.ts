import { isAbsolute } from "node:path";
import { operator } from "../admin/auth.ts";
import type { CodeTruthClient } from "../code-truth/client.ts";
import {
  type CodeTruthPage,
  codeTruthSaveSchema,
  codeTruthTools,
  emptyCodeTruth,
  targetsFor,
} from "../code-truth/config.ts";
import { codeTruthExtension } from "../code-truth/extension.ts";
import { codingExtension } from "../coding/extension.ts";
import type { Store } from "../db/repositories.ts";
import {
  type Admin,
  type Deployment,
  requireThat,
  TOOLS,
  type Workspace,
} from "../domain.ts";
import type { GitHubApp } from "../github/app.ts";
import { githubExtension } from "../github/extension.ts";
import { GitHubApps } from "../github/registry.ts";
import { repositoryAccess } from "../github/user-access.ts";
import { audit } from "../workspaces/policy.ts";
import { ExtensionCatalog } from "./extensions.ts";
import {
  type PluginPage,
  type PluginRecord,
  pluginSaveSchema,
} from "./plugin-config.ts";
import { PiRunner } from "./runtime.ts";

function authorizePlugins(admin: Admin, workspace: Workspace) {
  operator(admin);
  requireThat(
    workspace.operatorId === admin.id && !workspace.deletion,
    "access_denied",
    403,
  );
}

export class PluginService {
  constructor(
    private store: Store,
    private manifestPath?: string,
    private codeTruth?: CodeTruthClient,
    private githubApp?: GitHubApp | GitHubApps,
  ) {}
  private legacy?: Promise<PluginRecord[]>;
  private fallback(): Promise<PluginRecord[]> {
    this.legacy ??= this.manifestPath
      ? ExtensionCatalog.load(this.manifestPath).then((catalog) =>
          catalog.snapshot(),
        )
      : Promise.resolve([]);
    return this.legacy;
  }
  private async entries(workspace: Workspace): Promise<PluginRecord[]> {
    return (
      workspace.plugins?.entries ??
      (await this.fallback())
        .filter((entry) => entry.workspaces.includes(workspace.id))
        .map((entry) => ({ ...entry, workspaces: [workspace.id] }))
    );
  }
  async view(admin: Admin, workspaceId: string): Promise<PluginPage> {
    operator(admin);
    const workspace = await this.store.read(workspaceId);
    authorizePlugins(admin, workspace);
    let entries: PluginRecord[] = [];
    let notice: string | undefined;
    try {
      entries = await this.entries(workspace);
    } catch {
      notice =
        "The configured manifest could not be read. Check the API and worker file mounts.";
    }
    return {
      revision: workspace.plugins?.revision ?? 0,
      source: workspace.plugins
        ? "panel"
        : this.manifestPath
          ? "manifest"
          : "empty",
      notice,
      entries: await Promise.all(
        entries.map(async ({ hash, ...entry }) => ({
          ...entry,
          fileStatus: await ExtensionCatalog.fileStatus({ ...entry, hash }),
        })),
      ),
      workspaces: [{ id: workspace.id, name: workspace.settings.name }],
      audit: workspace.audit
        .filter((entry) => entry.action === "plugins.updated")
        .slice(-10)
        .reverse()
        .map(({ id, action, at }) => ({ id, action, at })),
    };
  }
  async save(admin: Admin, workspaceId: string, value: unknown) {
    operator(admin);
    const input = pluginSaveSchema.parse(value);
    requireThat(
      input.entries.every((entry) => isAbsolute(entry.path)),
      "extension_path_invalid",
    );
    await this.store.change(workspaceId, async (workspace) => {
      authorizePlugins(admin, workspace);
      const prior = workspace.plugins;
      requireThat(
        (prior?.revision ?? 0) === input.revision,
        "version_conflict",
        409,
      );
      const builtin = prior?.codeTruth;
      const names = new Set<string>(TOOLS);
      names.add("record_discussion");
      names.add("query_discussions");
      if (builtin?.enabled && targetsFor(builtin, workspaceId).length)
        for (const name of codeTruthTools) names.add(name);
      for (const entry of input.entries) {
        requireThat(
          entry.workspaces.length === 1 && entry.workspaces[0] === workspaceId,
          "access_denied",
          403,
        );
        if (!entry.enabled) continue;
        for (const tool of entry.tools) {
          requireThat(!names.has(tool), "extension_tool_collision", 409);
          names.add(tool);
        }
      }
      const entries = await ExtensionCatalog.fromManifest(input.entries);
      // Unrelated edits must not approve changed executable contents.
      for (const entry of entries) {
        const previous = prior?.entries.find((item) => item.id === entry.id);
        if (
          entry.enabled &&
          previous?.enabled &&
          entry.path === previous.path &&
          entry.version === previous.version
        )
          entry.hash = previous.hash;
      }
      workspace.plugins = { ...prior, revision: input.revision + 1, entries };
      audit(
        workspace,
        admin.id,
        "plugins.updated",
        "plugins",
        workspace.plugins.revision,
      );
    });
    return this.view(admin, workspaceId);
  }
  async codeTruthView(
    admin: Admin,
    workspaceId: string,
  ): Promise<CodeTruthPage> {
    operator(admin);
    const workspace = await this.store.read(workspaceId);
    authorizePlugins(admin, workspace);
    return {
      revision: workspace.plugins?.revision ?? 0,
      settings: structuredClone(workspace.plugins?.codeTruth ?? emptyCodeTruth),
      serviceConfigured: Boolean(this.codeTruth),
      workspaces: [{ id: workspace.id, name: workspace.settings.name }],
    };
  }
  async saveCodeTruth(admin: Admin, workspaceId: string, value: unknown) {
    operator(admin);
    const input = codeTruthSaveSchema.parse(value);
    await this.store.change(workspaceId, async (workspace) => {
      authorizePlugins(admin, workspace);
      const prior = workspace.plugins;
      requireThat(
        (prior?.revision ?? 0) === input.revision,
        "version_conflict",
        409,
      );
      const entries = await this.entries(workspace);
      for (const repo of input.settings.repositories) {
        requireThat(
          repo.workspaces.length === 1 && repo.workspaces[0] === workspaceId,
          "access_denied",
          403,
        );
        if (input.settings.enabled)
          for (const entry of entries)
            if (entry.enabled)
              requireThat(
                !entry.tools.some((name) =>
                  (codeTruthTools as readonly string[]).includes(name),
                ),
                "extension_tool_collision",
                409,
              );
      }
      workspace.plugins = {
        revision: input.revision + 1,
        entries,
        codeTruth: input.settings,
      };
      audit(
        workspace,
        admin.id,
        "plugins.updated",
        "code-truth",
        workspace.plugins.revision,
      );
    });
    return this.codeTruthView(admin, workspaceId);
  }
  private async codeClient(
    workspace: Workspace,
    targets: { repositoryUrl: string }[],
  ) {
    requireThat(this.codeTruth, "code_truth_unavailable", 503);
    if (!workspace.github) return this.codeTruth;
    const connection = workspace.github;
    if (!connection.installationId)
      return this.codeTruth.withGitHub(async () => ({
        token: null,
        identity: `disconnected:${connection.revision}`,
      }));
    const app =
      this.githubApp instanceof GitHubApps
        ? await this.githubApp.get(workspace.operatorId)
        : this.githubApp;
    requireThat(app, "github_app_not_configured", 409);
    const ids = targets.map((target) => {
      const name = new URL(target.repositoryUrl).pathname
        .slice(1)
        .replace(/\.git$/, "")
        .toLowerCase();
      const repo = connection.repositories.find(
        (r) => r.full_name.toLowerCase() === name,
      );
      requireThat(repo, "github_repository_not_connected", 409);
      return repo.id;
    });
    let cached: { token: string; expires_at: string } | undefined;
    return this.codeTruth.withGitHub(async () => {
      if (!cached || Date.parse(cached.expires_at) < Date.now() + 60000)
        cached = await app.installationToken(
          connection.installationId as number,
          [...new Set(ids)],
        );
      return {
        token: cached.token,
        identity: `app:${app.config.id}:${connection.installationId}:${connection.revision}`,
      };
    });
  }
  async codeTruthStatus(admin: Admin, workspaceId: string) {
    operator(admin);
    const workspace = await this.store.read(workspaceId);
    authorizePlugins(admin, workspace);
    const settings = workspace.plugins?.codeTruth ?? emptyCodeTruth;
    requireThat(settings.enabled, "code_truth_disabled", 409);
    const targets = targetsFor(settings, workspaceId);
    requireThat(targets.length, "code_truth_no_repositories", 409);
    requireThat(this.codeTruth, "code_truth_unavailable", 503);
    const client = await this.codeClient(workspace, targets);
    const { namespace: _, ...status } = await client.configure(
      workspaceId,
      targets,
    );
    return status;
  }
  async runner(_deployment: Deployment, workspaceId: string) {
    const workspace = await this.store.read(workspaceId);
    requireThat(!workspace.deletion, "access_denied", 403);
    const scoped = (await this.entries(workspace)).filter(
      (entry) => entry.enabled && entry.workspaces.includes(workspaceId),
    );
    const config = workspace.plugins?.codeTruth;
    const targets = config?.enabled ? targetsFor(config, workspaceId) : [];
    const builtins = [];
    if (workspace.coding?.settings.enabled && workspace.github?.installationId)
      builtins.push(codingExtension(this.store, workspace));
    if (
      workspace.github?.installationId &&
      workspace.github.repositories.length
    )
      builtins.push(githubExtension(this.store, workspaceId, workspace.github));
    if (targets.length) {
      requireThat(this.codeTruth, "code_truth_unavailable", 503);
      builtins.push(
        await codeTruthExtension(
          await this.codeClient(workspace, targets),
          workspaceId,
          targets,
          workspace.github?.revision,
          async (actor) => {
            const current = await this.store.read(workspaceId);
            const allowed = targets.filter((target) => {
              if (!current.members.find((m) => m.id === actor)?.github)
                return true;
              const name = new URL(target.repositoryUrl).pathname
                .slice(1)
                .replace(/\.git$/, "")
                .toLowerCase();
              const repo = current.github?.repositories.find(
                (r) => r.full_name.toLowerCase() === name,
              );
              return !!repo && repositoryAccess(current, actor, repo.id);
            });
            requireThat(allowed.length, "github_user_access_denied", 403);
            return {
              client: await this.codeClient(current, allowed),
              targets: allowed,
            };
          },
        ),
      );
    }
    return new PiRunner(
      undefined,
      scoped.length || builtins.length
        ? ExtensionCatalog.fromSnapshot(scoped, builtins)
        : undefined,
    );
  }
}
