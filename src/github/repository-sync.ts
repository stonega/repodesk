import { operator } from "../admin/auth.ts";
import type { Sql } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, Fault, requireThat, type Workspace } from "../domain.ts";
import { fingerprint } from "../setup/credentials.ts";
import { audit } from "../workspaces/policy.ts";
import type { GitHubApp, GitHubRepository } from "./app.ts";
import { githubConnectionRevision } from "./config.ts";
import type { GitHubApps } from "./registry.ts";

type Refresh = {
  identity: string;
  checkedAt: number;
  credential?: { token: string; expires_at: string };
  pending?: Promise<void>;
  error?: string;
};

export interface RepositorySyncSummary {
  changed: boolean;
  total: number;
  added: number;
  removed: number;
  addedNames: string[];
  allRepositories: boolean;
}

function authorize(admin: Admin, w: Workspace) {
  operator(admin);
  requireThat(w.operatorId === admin.id && !w.deletion, "access_denied", 403);
}

export function mergeRepositories(
  saved: GitHubRepository[],
  accessible: GitHubRepository[],
  allRepositories = false,
): GitHubRepository[] {
  const byId = new Map(accessible.map((r) => [r.id, r]));
  const existingIds = new Set<number>();
  const merged = saved.flatMap((entry) => {
    const current = byId.get(entry.id);
    if (!current) return [];
    existingIds.add(entry.id);
    return [{ ...entry, ...current }];
  });
  if (!allRepositories) return merged;
  for (const repo of accessible) {
    if (!existingIds.has(repo.id)) merged.push(repo);
  }
  return merged;
}

function repositoryPolicy(repositories: GitHubRepository[] = []) {
  return fingerprint(
    repositories.map(({ pushed_at, updated_at, ...policy }) => policy),
  );
}

function diffRepositories(
  previous: GitHubRepository[],
  next: GitHubRepository[],
) {
  const prevIds = new Set(previous.map((r) => r.id));
  const nextIds = new Set(next.map((r) => r.id));
  const addedRepos = next.filter((r) => !prevIds.has(r.id));
  const removedCount = previous.filter((r) => !nextIds.has(r.id)).length;
  return {
    added: addedRepos.length,
    removed: removedCount,
    addedNames: addedRepos.map((r) => r.full_name),
  };
}

function applyRepositoryState(
  w: Workspace,
  previousRepositories: GitHubRepository[],
  previousAllRepositories: boolean,
  repositories: GitHubRepository[],
  nextAllRepositories: boolean,
  actor?: string,
) {
  const connection = w.github;
  if (!connection) return { changed: false, policyChanged: false };
  const metadataChanged =
    JSON.stringify(repositories) !== JSON.stringify(previousRepositories);
  const modeChanged = previousAllRepositories !== nextAllRepositories;
  if (!metadataChanged && !modeChanged)
    return { changed: false, policyChanged: false };

  connection.repositories = repositories;
  if (nextAllRepositories) connection.allRepositories = true;
  else delete connection.allRepositories;

  // Activity timestamps affect menu ordering, not access or pending approvals.
  const policyChanged =
    modeChanged ||
    repositoryPolicy(repositories) !== repositoryPolicy(previousRepositories);
  if (policyChanged) {
    connection.connectionRevision = githubConnectionRevision(connection);
    const previousById = new Map(previousRepositories.map((r) => [r.id, r]));
    const currentById = new Map(repositories.map((r) => [r.id, r]));
    for (const previous of previousRepositories) {
      const next = currentById.get(previous.id);
      if (!next || repositoryPolicy([previous]) !== repositoryPolicy([next])) {
        connection.repositoryRevisions ??= {};
        connection.repositoryRevisions[previous.id] = connection.revision + 1;
      }
    }
    for (const next of repositories) {
      if (!previousById.has(next.id)) {
        connection.repositoryRevisions ??= {};
        connection.repositoryRevisions[next.id] = connection.revision + 1;
      }
    }
    connection.revision++;
  }
  // Existing Code Truth targets follow the same numeric repository identity.
  let targetsChanged = false;
  for (const target of w.plugins?.codeTruth?.repositories ?? []) {
    if (!target.workspaces.includes(w.id)) continue;
    const name = new URL(target.repositoryUrl).pathname
      .slice(1)
      .replace(/\.git$/, "");
    const saved = previousRepositories.find(
      (r) => r.full_name.toLowerCase() === name.toLowerCase(),
    );
    const current = repositories.find((r) => r.id === saved?.id);
    if (current && current.full_name !== saved?.full_name) {
      target.repositoryUrl = `https://github.com/${current.full_name}${target.repositoryUrl.endsWith(".git") ? ".git" : ""}`;
      targetsChanged = true;
    }
  }
  if (targetsChanged && w.plugins) w.plugins.revision++;
  if (actor && policyChanged)
    audit(
      w,
      actor,
      "github.repositories_updated",
      String(connection.installationId ?? w.id),
      connection.revision,
    );
  return { changed: true, policyChanged, revision: connection.revision };
}

/**
 * Refresh repository metadata from GitHub.
 * Selected-only workspaces keep their saved numeric IDs; workspaces with
 * `allRepositories: true` automatically include newly accessible repositories.
 */
export class RepositorySync {
  private refreshes = new Map<string, Refresh>();
  constructor(
    private store: Store,
    private apps: GitHubApps,
    private now = Date.now,
  ) {}

  private entryFor(
    id: string,
    w: Workspace,
    app: GitHubApp,
    installationId: number,
  ) {
    const identity = `${w.operatorId}:${app.config.id}:${app.config.clientId}:${installationId}:${w.github?.revision}:${w.github?.allRepositories ? 1 : 0}`;
    let refresh = this.refreshes.get(id);
    if (refresh?.identity !== identity) {
      // Entries are transient, scoped to the workspace, and never persisted/logged.
      for (const [key, entry] of this.refreshes)
        if (!entry.pending && entry.checkedAt < this.now() - 3600000)
          this.refreshes.delete(key);
      refresh = { identity, checkedAt: Number.NEGATIVE_INFINITY };
      this.refreshes.set(id, refresh);
    }
    return refresh;
  }

  private async fetchAccessible(
    app: GitHubApp,
    installationId: number,
    refresh: Refresh,
  ) {
    if (
      !refresh.credential ||
      Date.parse(refresh.credential.expires_at) < this.now() + 60000
    )
      refresh.credential = await app.metadataToken(installationId);
    return app.installationRepositories(refresh.credential.token);
  }

  async refresh(admin: Admin, id: string) {
    const w = await this.store.read(id);
    authorize(admin, w);
    const installationId = w.github?.installationId;
    if (!installationId) {
      this.refreshes.delete(id);
      return { workspace: w };
    }
    const app = await this.apps.get(w.operatorId);
    if (!app)
      return { workspace: w, refreshError: "github_app_not_configured" };
    const refresh = this.entryFor(id, w, app, installationId);
    if (!refresh.pending && this.now() - refresh.checkedAt >= 3000) {
      const entry = refresh;
      entry.pending = this.sync(w, app, installationId, entry, (current) =>
        authorize(admin, current),
      )
        .then(() => {})
        .finally(() => {
          entry.pending = undefined;
          entry.checkedAt = this.now();
        });
    }
    await refresh.pending;
    const current = await this.store.read(id);
    authorize(admin, current);
    return { workspace: current, refreshError: refresh.error };
  }

  async syncWorkspace(
    id: string,
    options?: {
      force?: boolean;
      minAgeMs?: number;
      allRepositories?: boolean;
      actor?: string;
      check?: (w: Workspace) => void;
    },
  ): Promise<{
    workspace: Workspace;
    summary: RepositorySyncSummary;
    refreshError?: string;
  }> {
    const w = await this.store.read(id);
    options?.check?.(w);
    const github = w.github;
    const installationId = github?.installationId;
    if (!github || !installationId || w.deletion) {
      this.refreshes.delete(id);
      return {
        workspace: w,
        summary: {
          changed: false,
          total: github?.repositories.length ?? 0,
          added: 0,
          removed: 0,
          addedNames: [],
          allRepositories: !!github?.allRepositories,
        },
      };
    }
    const app = await this.apps.get(w.operatorId);
    if (!app) {
      return {
        workspace: w,
        summary: {
          changed: false,
          total: github.repositories.length,
          added: 0,
          removed: 0,
          addedNames: [],
          allRepositories: !!github.allRepositories,
        },
        refreshError: "github_app_not_configured",
      };
    }
    const refresh = this.entryFor(id, w, app, installationId);
    const minAgeMs = options?.force ? 0 : (options?.minAgeMs ?? 3000);
    const modeChange =
      options?.allRepositories !== undefined &&
      options.allRepositories !== !!github.allRepositories;
    const beforeRepos = structuredClone(github.repositories);
    let summary: RepositorySyncSummary = {
      changed: false,
      total: beforeRepos.length,
      added: 0,
      removed: 0,
      addedNames: [],
      allRepositories: options?.allRepositories ?? !!github.allRepositories,
    };
    if (
      options?.force ||
      modeChange ||
      (!refresh.pending && this.now() - refresh.checkedAt >= minAgeMs)
    ) {
      if (refresh.pending) await refresh.pending;
      const snapshot = await this.store.read(id);
      options?.check?.(snapshot);
      if (
        snapshot.github?.installationId === installationId &&
        !snapshot.deletion
      ) {
        const entry = this.entryFor(id, snapshot, app, installationId);
        const run = this.sync(
          snapshot,
          app,
          installationId,
          entry,
          options?.check,
          options?.allRepositories,
          options?.actor,
        )
          .then((result) => {
            if (result) summary = result;
          })
          .finally(() => {
            entry.pending = undefined;
            entry.checkedAt = this.now();
          });
        entry.pending = run;
        await run;
      }
    } else if (refresh.pending) {
      await refresh.pending;
    }
    const current = await this.store.read(id);
    options?.check?.(current);
    const diff = diffRepositories(
      beforeRepos,
      current.github?.repositories ?? [],
    );
    if (!summary.changed && (diff.added > 0 || diff.removed > 0)) {
      summary = {
        changed: true,
        total: current.github?.repositories.length ?? 0,
        added: diff.added,
        removed: diff.removed,
        addedNames: diff.addedNames,
        allRepositories: !!current.github?.allRepositories,
      };
    } else {
      summary = {
        ...summary,
        total: current.github?.repositories.length ?? 0,
        allRepositories: !!current.github?.allRepositories,
      };
    }
    const latestEntry = this.refreshes.get(id);
    return {
      workspace: current,
      summary,
      refreshError: latestEntry?.error,
    };
  }

  /**
   * Sync repositories inside an already-open workspace transaction (for Telegram commands/tools).
   * Throws Fault on missing connection, missing App, or upstream GitHub failure.
   */
  async syncInTransaction(
    sql: Sql,
    w: Workspace,
    options?: { allRepositories?: boolean; actor?: string },
  ): Promise<RepositorySyncSummary> {
    const github = w.github;
    const installationId = github?.installationId;
    requireThat(
      github && installationId && !w.deletion,
      "github_repository_not_connected",
      409,
    );
    const app = await this.apps.get(w.operatorId);
    requireThat(app, "github_app_not_configured", 409);
    const refresh = this.entryFor(w.id, w, app, installationId);
    let accessible: GitHubRepository[];
    try {
      accessible = await this.fetchAccessible(app, installationId, refresh);
      refresh.error = undefined;
      refresh.checkedAt = this.now();
    } catch (error) {
      refresh.credential = undefined;
      refresh.error =
        error instanceof Fault ? error.code : "github_unavailable";
      throw error instanceof Fault
        ? error
        : new Fault("github_unavailable", 502);
    }
    const previousRepos = structuredClone(github.repositories);
    const previousAll = !!github.allRepositories;
    const nextAll = options?.allRepositories ?? previousAll;
    const repositories = mergeRepositories(previousRepos, accessible, nextAll);
    const diff = diffRepositories(previousRepos, repositories);
    const applied = applyRepositoryState(
      w,
      previousRepos,
      previousAll,
      repositories,
      nextAll,
      options?.actor,
    );
    if (applied.policyChanged) {
      await sql.query(
        "UPDATE github_user_accounts SET next_sync_at=LEAST(next_sync_at, now()) WHERE workspace_id=$1",
        [w.id],
      );
    }
    if (applied.revision !== undefined) {
      refresh.identity = `${w.operatorId}:${app.config.id}:${app.config.clientId}:${installationId}:${applied.revision}:${nextAll ? 1 : 0}`;
    }
    return {
      changed: applied.changed,
      total: repositories.length,
      added: diff.added,
      removed: diff.removed,
      addedNames: diff.addedNames,
      allRepositories: nextAll,
    };
  }

  async syncAllWorkspaces(signal?: AbortSignal, minAgeMs = 5 * 60000) {
    for (const id of await this.store.ids()) {
      if (signal?.aborted) break;
      try {
        const w = await this.store.read(id);
        if (
          w.deletion ||
          !w.github?.installationId ||
          !w.github.allRepositories
        )
          continue;
        await this.syncWorkspace(id, { minAgeMs });
      } catch {
        this.store.log.write("worker_maintenance_failed", {
          workspaceId: id,
          error: new Fault("github_repository_sync_failed", 503),
        });
      }
    }
  }

  private async sync(
    snapshot: Workspace,
    app: GitHubApp,
    installationId: number,
    refresh: Refresh,
    check?: (w: Workspace) => void,
    targetAllRepositories?: boolean,
    actor?: string,
  ): Promise<RepositorySyncSummary | undefined> {
    let accessible: GitHubRepository[];
    try {
      accessible = await this.fetchAccessible(app, installationId, refresh);
      refresh.error = undefined;
    } catch (error) {
      refresh.credential = undefined;
      refresh.error =
        error instanceof Fault ? error.code : "github_unavailable";
      return undefined;
    }
    const previousRepos = snapshot.github?.repositories ?? [];
    const previousAll = !!snapshot.github?.allRepositories;
    const nextAll = targetAllRepositories ?? previousAll;
    const repositories = mergeRepositories(previousRepos, accessible, nextAll);
    const diff = diffRepositories(previousRepos, repositories);
    if (
      nextAll === previousAll &&
      JSON.stringify(repositories) === JSON.stringify(previousRepos)
    ) {
      return {
        changed: false,
        total: repositories.length,
        added: 0,
        removed: 0,
        addedNames: [],
        allRepositories: nextAll,
      };
    }
    const result = await this.store.change(snapshot.id, async (w, sql) => {
      check?.(w);
      const connection = w.github;
      // A delayed response must never overwrite a reconnect or disconnect.
      if (
        w.deletion ||
        connection?.installationId !== installationId ||
        connection.revision !== snapshot.github?.revision
      )
        return undefined;
      const applied = applyRepositoryState(
        w,
        snapshot.github?.repositories ?? [],
        previousAll,
        repositories,
        nextAll,
        actor,
      );
      if (applied.policyChanged) {
        await sql.query(
          "UPDATE github_user_accounts SET next_sync_at=LEAST(next_sync_at, now()) WHERE workspace_id=$1",
          [w.id],
        );
      }
      return {
        revision: connection.revision,
        changed: applied.changed,
      };
    });
    if (result?.revision !== undefined) {
      refresh.identity = `${snapshot.operatorId}:${app.config.id}:${app.config.clientId}:${installationId}:${result.revision}:${nextAll ? 1 : 0}`;
    }
    return {
      changed: !!result?.changed,
      total: repositories.length,
      added: diff.added,
      removed: diff.removed,
      addedNames: diff.addedNames,
      allRepositories: nextAll,
    };
  }
}
