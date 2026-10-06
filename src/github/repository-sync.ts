import { operator } from "../admin/auth.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, Fault, requireThat, type Workspace } from "../domain.ts";
import type { GitHubApp, GitHubRepository } from "./app.ts";
import type { GitHubApps } from "./registry.ts";

type Refresh = {
  identity: string;
  checkedAt: number;
  credential?: { token: string; expires_at: string };
  pending?: Promise<void>;
  error?: string;
};

function authorize(admin: Admin, w: Workspace) {
  operator(admin);
  requireThat(w.operatorId === admin.id && !w.deletion, "access_denied", 403);
}

function selectedRepositories(w: Workspace, accessible: GitHubRepository[]) {
  const byId = new Map(accessible.map((r) => [r.id, r]));
  return (w.github?.repositories ?? []).flatMap((saved) => {
    const current = byId.get(saved.id);
    return current ? [{ ...saved, ...current }] : [];
  });
}

/** Refresh metadata without granting newly installed repositories to a workspace. */
export class RepositorySync {
  private refreshes = new Map<string, Refresh>();
  constructor(
    private store: Store,
    private apps: GitHubApps,
    private now = Date.now,
  ) {}

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
    const identity = `${w.operatorId}:${app.config.id}:${app.config.clientId}:${installationId}:${w.github?.revision}`;
    let refresh = this.refreshes.get(id);
    if (refresh?.identity !== identity) {
      // Entries are transient, scoped to the workspace, and never persisted/logged.
      for (const [key, entry] of this.refreshes)
        if (!entry.pending && entry.checkedAt < this.now() - 3600000)
          this.refreshes.delete(key);
      refresh = { identity, checkedAt: Number.NEGATIVE_INFINITY };
      this.refreshes.set(id, refresh);
    }
    if (!refresh.pending && this.now() - refresh.checkedAt >= 3000) {
      const entry = refresh;
      entry.pending = this.sync(admin, w, app, installationId, entry).finally(
        () => {
          entry.pending = undefined;
          entry.checkedAt = this.now();
        },
      );
    }
    await refresh.pending;
    const current = await this.store.read(id);
    authorize(admin, current);
    return { workspace: current, refreshError: refresh.error };
  }

  private async sync(
    admin: Admin,
    snapshot: Workspace,
    app: GitHubApp,
    installationId: number,
    refresh: Refresh,
  ) {
    let accessible: GitHubRepository[];
    try {
      if (
        !refresh.credential ||
        Date.parse(refresh.credential.expires_at) < this.now() + 60000
      )
        refresh.credential = await app.metadataToken(installationId);
      accessible = await app.installationRepositories(refresh.credential.token);
      refresh.error = undefined;
    } catch (error) {
      refresh.credential = undefined;
      refresh.error =
        error instanceof Fault ? error.code : "github_unavailable";
      return;
    }
    const repositories = selectedRepositories(snapshot, accessible);
    if (
      JSON.stringify(repositories) ===
      JSON.stringify(snapshot.github?.repositories)
    )
      return;
    const revision = await this.store.change(snapshot.id, (w) => {
      authorize(admin, w);
      const connection = w.github;
      // A delayed response must never overwrite a reconnect or disconnect.
      if (
        connection?.installationId !== installationId ||
        connection.revision !== snapshot.github?.revision
      )
        return;
      connection.repositories = repositories;
      connection.revision++;
      // Existing Code Truth targets follow the same numeric repository identity.
      let targetsChanged = false;
      for (const target of w.plugins?.codeTruth?.repositories ?? []) {
        if (!target.workspaces.includes(w.id)) continue;
        const name = new URL(target.repositoryUrl).pathname
          .slice(1)
          .replace(/\.git$/, "");
        const saved = snapshot.github?.repositories.find(
          (r) => r.full_name.toLowerCase() === name.toLowerCase(),
        );
        const current = repositories.find((r) => r.id === saved?.id);
        if (current && current.full_name !== saved?.full_name) {
          target.repositoryUrl = `https://github.com/${current.full_name}${target.repositoryUrl.endsWith(".git") ? ".git" : ""}`;
          targetsChanged = true;
        }
      }
      if (targetsChanged && w.plugins) w.plugins.revision++;
      return connection.revision;
    });
    if (revision !== undefined)
      refresh.identity = `${snapshot.operatorId}:${app.config.id}:${app.config.clientId}:${installationId}:${revision}`;
  }
}
