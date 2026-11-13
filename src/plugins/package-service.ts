import { randomUUID } from "node:crypto";
import { z } from "zod";
import { operator } from "../admin/auth.ts";
import type { PluginRecord } from "../agent/plugin-config.ts";
import type { AgentInput } from "../agent/runtime.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, Fault, requireThat, type Workspace } from "../domain.ts";
import type { GitHubApp } from "../github/app.ts";
import { GitHubMetadata } from "../github/metadata.ts";
import { GitHubApps } from "../github/registry.ts";
import { decrypt, encrypt, fingerprint } from "../setup/credentials.ts";
import { audit, eligible, runAllowed } from "../workspaces/policy.ts";
import { PluginArtifacts } from "./artifacts.ts";
import type { Json } from "./contract.ts";
import { PluginError } from "./contract.ts";
import type { PluginSandbox } from "./docker-sandbox.ts";
import { packageExtension, packageToolNames } from "./extension.ts";
import { GitHubPluginSource, parseRepositoryUrl } from "./github-source.ts";
import { PluginHttpReader } from "./http-reader.ts";
import {
  authorizeBroker,
  validateInput,
  validateSettings,
} from "./invocation.ts";
import type { PackageCatalog } from "./package-config.ts";
import {
  applyInput,
  type PackageArtifact,
  type PackageInstallation,
  type PackagePreview,
  packageConnectionInput,
  packageUpdateInput,
  previewInput,
} from "./package-config.ts";
import { guideText, packageGuides } from "./package-skills.ts";

export interface PluginPackageOptions {
  directory?: string;
  runtimeIdentity?: string;
  sandbox?: PluginSandbox;
  source?: GitHubPluginSource;
  encryptionKey?: string;
  http?: PluginHttpReader;
}
export function authorizePackages(admin: Admin, w: Workspace) {
  operator(admin);
  requireThat(w.operatorId === admin.id && !w.deletion, "access_denied", 403);
}
function connectionGuard(w: Workspace, preview: PackagePreview) {
  const source = preview.sourceConnection;
  if (source)
    requireThat(
      w.github?.installationId === source.installationId &&
        w.github.revision === source.revision &&
        w.github.repositories.some((r) => r.id === source.repositoryId),
      "plugin_source_changed",
      409,
    );
}
const artifact = (p: PackageArtifact): PackageArtifact => ({
  guides: p.guides,
  manifest: p.manifest,
  source: p.source,
  digest: p.digest,
  bundleHash: p.bundleHash,
  manifestHash: p.manifestHash,
});
const publicInstallation = (p: PackageInstallation) => ({
  ...p,
  connections: p.connections.map(({ encrypted, ...connection }) => ({
    ...connection,
    configured:
      !!encrypted ||
      p.manifest.connections?.find((c) => c.id === connection.id)?.auth.type ===
        "none",
  })),
});

export class PluginPackages {
  readonly artifacts?: PluginArtifacts;
  readonly source: GitHubPluginSource;
  private readonly http: PluginHttpReader;
  constructor(
    readonly store: Store,
    readonly options: PluginPackageOptions = {},
    private apps?: GitHubApps | GitHubApp,
    private legacyEntries: (w: Workspace) => Promise<PluginRecord[]> = async (
      w,
    ) => w.plugins?.entries ?? [],
  ) {
    this.artifacts = options.directory
      ? new PluginArtifacts(options.directory)
      : undefined;
    this.source = options.source ?? new GitHubPluginSource();
    this.http = options.http ?? new PluginHttpReader();
  }
  private async token(w: Workspace, repository: string) {
    const selected = w.github?.repositories.find(
      (r) => r.full_name.toLowerCase() === repository.toLowerCase(),
    );
    if (!selected || !w.github?.installationId) return {};
    const app =
      this.apps instanceof GitHubApps
        ? await this.apps.get(w.operatorId)
        : this.apps;
    requireThat(app, "github_app_not_configured", 409);
    const token = await app.installationToken(
      w.github.installationId,
      [selected.id],
      "contents",
    );
    return {
      token: token.token,
      sourceConnection: {
        installationId: w.github.installationId,
        repositoryId: selected.id,
        revision: w.github.revision,
      },
    };
  }
  async view(admin: Admin, workspaceId: string) {
    const w = await this.store.read(workspaceId);
    authorizePackages(admin, w);
    return this.catalog(w);
  }
  catalog(w: Workspace): PackageCatalog {
    return {
      revision: w.plugins?.revision ?? 0,
      configured: !!this.artifacts,
      runnerConfigured: !!this.options.sandbox,
      entries: (w.plugins?.packages ?? []).map(publicInstallation),
      members: w.members
        .filter((m) => m.active)
        .map((m) => ({ id: m.id, name: m.name ?? m.username ?? m.id })),
      chats: w.chats
        .filter((c) => c.active)
        .map((c) => ({
          id: c.id,
          name: c.title ? `${c.title} (${c.id})` : c.id,
        })),
    };
  }
  async collect(admin: Admin, workspaceId: string, value: unknown) {
    const input = z
      .object({ revision: z.number().int().min(0) })
      .strict()
      .parse(value);
    return this.store.change(workspaceId, async (w) => {
      authorizePackages(admin, w);
      requireThat(
        (w.plugins?.revision ?? 0) === input.revision,
        "version_conflict",
        409,
      );
      requireThat(this.artifacts, "plugin_storage_unavailable", 409);
      const retained = new Set<string>();
      for (const installation of w.plugins?.packages ?? []) {
        retained.add(installation.digest);
        for (const prior of installation.history) retained.add(prior.digest);
      }
      for (const preview of w.pluginPackagePreviews ?? [])
        if (Date.parse(preview.expiresAt) > Date.now())
          retained.add(preview.digest);
      for (const run of w.runs)
        for (const pin of Object.values(run.packageRead?.installations ?? {}))
          retained.add(pin.digest);
      const removed = await this.artifacts.collect(workspaceId, retained);
      audit(
        w,
        admin.id,
        "plugins.package_artifacts_collected",
        workspaceId,
        w.plugins?.revision ?? 0,
      );
      return { removed };
    });
  }
  async preview(
    admin: Admin,
    workspaceId: string,
    value: unknown,
    requestSignal?: AbortSignal,
  ) {
    const input = previewInput.parse(value);
    const w = await this.store.read(workspaceId);
    authorizePackages(admin, w);
    requireThat(this.artifacts, "plugin_storage_unavailable", 409);
    const hash = fingerprint(input);
    const prior = w.pluginPackagePreviews?.find(
      (p) =>
        p.requestId === input.requestId &&
        p.actor === admin.id &&
        !p.consumed &&
        Date.parse(p.expiresAt) > Date.now(),
    );
    if (prior) {
      requireThat(
        prior.requestHash === hash &&
          prior.revision === (w.plugins?.revision ?? 0),
        "version_conflict",
        409,
      );
      connectionGuard(w, prior);
      return prior;
    }
    requireThat(
      (w.plugins?.revision ?? 0) === input.revision,
      "version_conflict",
      409,
    );
    const name = parseRepositoryUrl(input.url);
    const signal = AbortSignal.any([
      AbortSignal.timeout(30000),
      ...(requestSignal ? [requestSignal] : []),
    ]);
    let candidate: PackageArtifact;
    let sourceConnection: PackagePreview["sourceConnection"];
    if (input.intent === "rollback") {
      const installed = w.plugins?.packages?.find(
        (p) => p.source.repository.toLowerCase() === name.toLowerCase(),
      );
      const retained = installed?.history.find(
        (p) => p.source.commit === input.ref,
      );
      requireThat(retained, "plugin_rollback_unavailable", 409);
      await this.artifacts.get(workspaceId, retained.digest);
      candidate = {
        ...artifact(retained),
        source: { ...retained.source, ref: retained.source.commit },
      };
      const access = await this.token(w, candidate.source.repository);
      await this.source.recheck(candidate.source, access.token, signal);
      sourceConnection = access.sourceConnection;
      if (candidate.source.private)
        requireThat(
          sourceConnection?.repositoryId === candidate.source.repositoryId,
          "access_denied",
          403,
        );
    } else {
      const access = await this.token(w, name);
      const pkg = await this.source.inspect(
        input.url,
        input.ref,
        access.token,
        signal,
      );
      candidate = artifact({
        ...pkg,
        guides: packageGuides(pkg.manifest, pkg.files),
      });
      sourceConnection = access.sourceConnection;
      if (pkg.source.private)
        requireThat(
          sourceConnection?.repositoryId === pkg.source.repositoryId,
          "access_denied",
          403,
        );
      await this.artifacts.put(workspaceId, pkg.files);
    }
    const preview: PackagePreview = {
      ...candidate,
      id: randomUUID(),
      actor: admin.id,
      revision: input.revision,
      expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
      intent: input.intent,
      requestId: input.requestId,
      requestHash: hash,
      sourceConnection,
    };
    let resolved = preview;
    await this.store.change(workspaceId, (current) => {
      authorizePackages(admin, current);
      requireThat(
        (current.plugins?.revision ?? 0) === input.revision,
        "version_conflict",
        409,
      );
      connectionGuard(current, preview);
      const duplicate = current.pluginPackagePreviews?.find(
        (p) =>
          p.actor === admin.id &&
          p.requestId === input.requestId &&
          !p.consumed &&
          Date.parse(p.expiresAt) > Date.now(),
      );
      if (duplicate) {
        requireThat(duplicate.requestHash === hash, "version_conflict", 409);
        resolved = duplicate;
        return;
      }
      const installed = current.plugins?.packages?.find(
        (p) => p.source.repositoryId === candidate.source.repositoryId,
      );
      requireThat(
        (input.intent === "install") === !installed,
        "plugin_installation_changed",
        409,
      );
      if (installed)
        requireThat(
          ![installed, ...installed.history].some(
            (p) =>
              p.manifest.version === candidate.manifest.version &&
              p.digest !== candidate.digest,
          ),
          "plugin_version_republished",
          409,
        );
      current.pluginPackagePreviews = [
        ...(current.pluginPackagePreviews ?? [])
          .filter(
            (p) =>
              Date.parse(p.expiresAt) > Date.now() &&
              p.requestId !== input.requestId,
          )
          .slice(-7),
        preview,
      ];
    });
    return resolved;
  }
  async apply(admin: Admin, workspaceId: string, value: unknown) {
    const input = applyInput.parse(value);
    const w = await this.store.read(workspaceId);
    authorizePackages(admin, w);
    const preview = w.pluginPackagePreviews?.find(
      (p) => p.id === input.previewId && p.actor === admin.id,
    );
    requireThat(
      preview && Date.parse(preview.expiresAt) > Date.now(),
      "plugin_preview_expired",
      409,
    );
    connectionGuard(w, preview);
    if (preview.consumed) {
      requireThat(
        w.plugins?.packages?.some(
          (p) =>
            p.digest === preview.digest && p.generation === preview.generation,
        ),
        "version_conflict",
        409,
      );
      return this.view(admin, workspaceId);
    }
    requireThat(
      (w.plugins?.revision ?? 0) === input.revision &&
        preview.revision === input.revision,
      "version_conflict",
      409,
    );
    requireThat(this.artifacts, "plugin_storage_unavailable", 409);
    await this.artifacts.get(workspaceId, preview.digest);
    {
      const access = await this.token(w, preview.source.repository);
      await this.source.recheck(
        preview.source,
        access.token,
        AbortSignal.timeout(15000),
      );
    }
    await this.store.change(workspaceId, async (current) => {
      authorizePackages(admin, current);
      const applied = current.pluginPackagePreviews?.find(
        (p) => p.id === preview.id && p.actor === admin.id && p.consumed,
      );
      if (applied) {
        requireThat(
          current.plugins?.packages?.some(
            (p) =>
              p.digest === applied.digest &&
              p.generation === applied.generation,
          ),
          "version_conflict",
          409,
        );
        return;
      }
      requireThat(
        (current.plugins?.revision ?? 0) === input.revision,
        "version_conflict",
        409,
      );
      connectionGuard(current, preview);
      const saved = current.pluginPackagePreviews?.find(
        (p) => p.id === preview.id && !p.consumed,
      );
      requireThat(
        saved && saved.digest === preview.digest,
        "version_conflict",
        409,
      );
      const previous = current.plugins?.packages?.find(
        (p) => p.source.repositoryId === preview.source.repositoryId,
      );
      requireThat(
        (preview.intent === "install") === !previous,
        "plugin_installation_changed",
        409,
      );
      requireThat(
        previous || (current.plugins?.packages?.length ?? 0) < 32,
        "plugin_package_limit",
        409,
      );
      let settings = {};
      try {
        settings = validateSettings(preview.manifest, previous?.settings ?? {});
      } catch {
        /* New required settings keep the package disabled until configured. */
      }
      const installation: PackageInstallation = {
        ...artifact(preview),
        generation: (previous?.generation ?? 0) + 1,
        enabled: false,
        settings,
        grants:
          previous?.grants.filter((c) =>
            preview.manifest.capabilities.includes(c),
          ) ?? [],
        history: previous
          ? [artifact(previous), ...previous.history]
              .filter(
                (p, i, all) =>
                  p.digest !== preview.digest &&
                  all.findIndex((v) => v.digest === p.digest) === i,
              )
              .slice(0, 5)
          : [],
        connections:
          previous?.connections.filter((connection) => {
            const old = previous.manifest.connections?.find(
              (c) => c.id === connection.id,
            );
            const next = preview.manifest.connections?.find(
              (c) => c.id === connection.id,
            );
            return old && next && fingerprint(old) === fingerprint(next);
          }) ?? [],
      };
      const entries = await this.legacyEntries(current);
      current.plugins = {
        ...current.plugins,
        entries,
        revision: input.revision + 1,
        packages: [
          ...(current.plugins?.packages ?? []).filter(
            (p) => p.source.repositoryId !== installation.source.repositoryId,
          ),
          installation,
        ],
      };
      saved.consumed = true;
      saved.generation = installation.generation;
      audit(
        current,
        admin.id,
        `plugins.package_${preview.intent}`,
        String(installation.source.repositoryId),
        current.plugins.revision,
      );
    });
    return this.view(admin, workspaceId);
  }
  async update(
    admin: Admin,
    workspaceId: string,
    repositoryId: number,
    value: unknown,
  ) {
    const input = packageUpdateInput.parse(value);
    await this.store.change(workspaceId, async (w) => {
      authorizePackages(admin, w);
      requireThat(
        w.plugins?.revision === input.revision,
        "version_conflict",
        409,
      );
      const installation = w.plugins.packages?.find(
        (p) => p.source.repositoryId === repositoryId,
      );
      requireThat(installation, "plugin_not_found", 404);
      requireThat(
        !input.enabled || !!this.options.sandbox,
        "plugin_runner_unavailable",
        409,
      );
      if (input.enabled) {
        const names = new Set(
          (await this.legacyEntries(w))
            .filter((entry) => entry.enabled)
            .flatMap((entry) => entry.tools),
        );
        requireThat(
          packageToolNames(installation).every((name) => !names.has(name)),
          "extension_tool_collision",
          409,
        );
      }
      requireThat(
        new Set(input.grants).size === input.grants.length &&
          input.grants.every((c) =>
            installation.manifest.capabilities.includes(c),
          ),
        "plugin_capability_denied",
        403,
      );
      installation.settings = validateSettings(
        installation.manifest,
        input.settings,
      );
      installation.enabled = input.enabled;
      installation.grants = input.grants;
      installation.generation++;
      w.plugins.revision++;
      audit(
        w,
        admin.id,
        "plugins.package_configured",
        String(repositoryId),
        w.plugins.revision,
      );
    });
    return this.view(admin, workspaceId);
  }
  async remove(
    admin: Admin,
    workspaceId: string,
    repositoryId: number,
    value: unknown,
  ) {
    const input = z
      .object({ revision: z.number().int().min(0) })
      .strict()
      .parse(value);
    await this.store.change(workspaceId, (w) => {
      authorizePackages(admin, w);
      requireThat(
        w.plugins?.revision === input.revision,
        "version_conflict",
        409,
      );
      requireThat(
        w.plugins.packages?.some((p) => p.source.repositoryId === repositoryId),
        "plugin_not_found",
        404,
      );
      w.plugins.packages = (w.plugins.packages ?? []).filter(
        (p) => p.source.repositoryId !== repositoryId,
      );
      w.plugins.revision++;
      audit(
        w,
        admin.id,
        "plugins.package_removed",
        String(repositoryId),
        w.plugins.revision,
      );
    });
    return this.view(admin, workspaceId);
  }
  async connect(
    admin: Admin,
    workspaceId: string,
    repositoryId: number,
    value: unknown,
  ) {
    const input = packageConnectionInput.parse(value);
    await this.store.change(workspaceId, (w) => {
      requireThat(!w.deletion, "access_denied", 403);
      requireThat(
        w.plugins?.revision === input.revision,
        "version_conflict",
        409,
      );
      const installation = w.plugins.packages?.find(
        (p) => p.source.repositoryId === repositoryId,
      );
      const descriptor = installation?.manifest.connections?.find(
        (c) => c.id === input.id,
      );
      requireThat(installation && descriptor, "plugin_not_found", 404);
      const actor =
        descriptor.scope === "member" ? admin.telegramId : undefined;
      if (descriptor.scope === "member")
        requireThat(
          actor &&
            eligible(w, actor) &&
            input.members.length === 0 &&
            input.chats.length === 0 &&
            input.privateOnly,
          "access_denied",
          403,
        );
      else authorizePackages(admin, w);
      requireThat(
        input.members.every((id) => eligible(w, id)) &&
          input.chats.every((id) =>
            w.chats.some((c) => c.id === id && c.active),
          ),
        "access_denied",
        403,
      );
      const old = installation.connections.find(
        (c) => c.id === input.id && c.actor === actor,
      );
      installation.connections = installation.connections.filter(
        (c) => c.id !== input.id || c.actor !== actor,
      );
      if (!input.disconnect) {
        requireThat(
          descriptor.auth.type !== "bearer" || !!this.options.encryptionKey,
          "plugin_connection_unavailable",
          409,
        );
        requireThat(
          descriptor.auth.type !== "bearer" ||
            !!input.token ||
            !!old?.encrypted,
          "plugin_connection_required",
          409,
        );
        installation.connections.push({
          id: input.id,
          actor,
          revision: (old?.revision ?? 0) + 1,
          members: input.members,
          privateOnly: input.privateOnly,
          chats: input.chats,
          encrypted:
            input.token && this.options.encryptionKey
              ? encrypt(
                  this.options.encryptionKey,
                  `plugin:${workspaceId}:${repositoryId}:${input.id}:${actor ?? "workspace"}`,
                  input.token,
                )
              : old?.encrypted,
        });
      }
      installation.generation++;
      w.plugins.revision++;
      audit(
        w,
        admin.id,
        "plugins.package_connection_updated",
        String(repositoryId),
        w.plugins.revision,
      );
    });
    return { saved: true };
  }
  extensions(w: Workspace) {
    return (w.plugins?.packages ?? [])
      .filter((p) => p.enabled)
      .map((installation) =>
        packageExtension(
          installation,
          w.id,
          w.plugins?.revision ?? 0,
          this.options.runtimeIdentity ?? "preview",
          (input, pkg, tool, args, signal) =>
            this.invoke(input, pkg, tool, args, signal),
        ),
      );
  }
  private async invoke(
    input: AgentInput,
    pinned: PackageInstallation,
    tool: string,
    value: unknown,
    signal: AbortSignal,
  ) {
    requireThat(input.workspaceId && !input.purpose, "access_denied", 403);
    const workspaceId = input.workspaceId;
    const guide = tool === "load_guide";
    if (!this.artifacts || (!guide && !this.options.sandbox))
      throw new PluginError("plugin_unavailable");
    const guideArgs = guide
      ? z
          .object({
            path: z.string().min(1).max(512).optional(),
            maxCharacters: z.number().int().min(256).max(16000).default(12000),
          })
          .strict()
          .parse(value)
      : undefined;
    const args = guide ? {} : validateInput(pinned.manifest, tool, value);
    const id = String(pinned.source.repositoryId);
    const check = async () => {
      signal.throwIfAborted();
      await input.guard();
      const w = await this.store.read(workspaceId);
      const run = w.runs.find((r) => r.id === input.runId);
      const current = w.plugins?.packages?.find(
        (p) => p.source.repositoryId === pinned.source.repositoryId,
      );
      requireThat(
        run &&
          run.status === "running" &&
          run.actor === input.actor &&
          runAllowed(w, run) &&
          current?.enabled &&
          current.digest === pinned.digest &&
          current.generation === pinned.generation,
        "tool_policy_denied",
        403,
      );
      return { w, run, current };
    };
    await check();
    await this.store.change(workspaceId, (w) => {
      const run = w.runs.find((r) => r.id === input.runId);
      requireThat(
        run &&
          run.actor === input.actor &&
          run.status === "running" &&
          runAllowed(w, run) &&
          w.plugins?.packages?.some(
            (p) =>
              p.source.repositoryId === pinned.source.repositoryId &&
              p.enabled &&
              p.digest === pinned.digest &&
              p.generation === pinned.generation,
          ),
        "tool_policy_denied",
        403,
      );
      run.packageRead ??= {
        revision: w.plugins?.revision ?? 0,
        installations: {},
      };
      requireThat(
        run.packageRead.revision === (w.plugins?.revision ?? 0),
        "tool_policy_denied",
        403,
      );
      run.packageRead.installations[id] = {
        digest: pinned.digest,
        generation: pinned.generation,
      };
    });
    const pkg = await this.artifacts.get(workspaceId, pinned.digest);
    if (guideArgs) {
      const path = guideArgs.path ?? pinned.manifest.skills[0]?.path;
      if (!path) throw new PluginError("plugin_permission_denied");
      const body = guideText(
        pinned.manifest,
        pkg.files,
        pinned.source.repositoryId,
        path,
      );
      const text = [...body].slice(0, guideArgs.maxCharacters).join("");
      await check();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              path,
              text,
              truncated: text.length < body.length,
              source: {
                repository: pinned.source.repository,
                commit: pinned.source.commit,
              },
            }),
          },
        ],
        details: { path },
      };
    }
    if (!this.options.sandbox) throw new PluginError("plugin_unavailable");
    const result = await this.options.sandbox.invoke({
      manifest: pinned.manifest,
      bundle: pkg.files[pinned.manifest.runtime.entry] as Buffer,
      bundleHash: pinned.bundleHash,
      tool,
      arguments: args,
      settings: pinned.settings,
      grants: pinned.grants,
      signal,
      guard: async () => {
        await check();
      },
      broker: async (raw, activeSignal): Promise<Json> => {
        const { run, current } = await check();
        const request = authorizeBroker(
          current.manifest,
          tool,
          current.grants,
          raw,
        );
        if (request.method === "github.repository.get") {
          if (!this.apps) throw new PluginError("plugin_unavailable");
          const data = await new GitHubMetadata(
            this.store,
            this.apps,
          ).repository(
            workspaceId,
            input.runId,
            { repositoryId: request.params.repositoryId, kind: "repository" },
            activeSignal,
            async () => {
              await check();
            },
          );
          return {
            url: data.url,
            stars: data.stars,
            forks: data.forks,
            subscribers: data.watchers,
            fetchedAt: data.retrievedAt,
          };
        }
        const descriptor = current.manifest.connections?.find(
          (c) => c.id === request.params.connection,
        );
        if (!descriptor) throw new PluginError("plugin_connection_required");
        const connection = current.connections.find(
          (c) =>
            c.id === descriptor.id &&
            c.actor === (descriptor.scope === "member" ? run.actor : undefined),
        );
        if (!connection) throw new PluginError("plugin_connection_required");
        if (descriptor.scope === "member" && run.chatId !== run.actor)
          throw new PluginError("plugin_permission_denied");
        if (
          descriptor.scope === "workspace" &&
          (!connection.members.includes(run.actor) ||
            (run.chatId !== run.actor &&
              (connection.privateOnly ||
                !connection.chats.includes(run.chatId))))
        )
          throw new PluginError("plugin_permission_denied");
        const rule = descriptor.requests.find(
          (r) =>
            r.paths.includes(request.params.path) &&
            Object.keys(request.params.query ?? {}).every((k) =>
              r.queryKeys.includes(k),
            ),
        );
        if (!rule) throw new PluginError("plugin_permission_denied");
        const key = this.options.encryptionKey;
        const bearer =
          descriptor.auth.type === "bearer" && key && connection.encrypted
            ? decrypt(
                key,
                `plugin:${workspaceId}:${pinned.source.repositoryId}:${descriptor.id}:${connection.actor ?? "workspace"}`,
                connection.encrypted,
              )
            : undefined;
        if (descriptor.auth.type === "bearer" && !bearer)
          throw new PluginError("plugin_connection_required");
        const response = await this.http.read(
          rule.origin,
          request.params.path,
          request.params.query ?? {},
          bearer,
          activeSignal,
        );
        await check();
        return response;
      },
    });
    await check();
    return { content: result.content, details: result.structuredContent };
  }
}

/** Route boundary keeps plugin errors fixed and never forwards raw exceptions. */
export function packageFault(error: unknown): never {
  if (error instanceof PluginError) throw new Fault(error.code, 409);
  throw error;
}
