import type { GitHubInstallation, GitHubRepository } from "./app.ts";
export type GitHubConnection = {
  revision: number;
  /** Last connection/selection change; metadata refreshes retain this generation. */
  connectionRevision?: number;
  /** Retain changed/removed IDs so a later restoration cannot revive old grants. */
  repositoryRevisions?: Record<string, number>;
  installationId?: number;
  account?: string;
  connectedBy?: string;
  connectedAt?: string;
  repositories: GitHubRepository[];
};
export const githubConnectionRevision = (connection: GitHubConnection) =>
  connection.connectionRevision ?? connection.revision;
/** A catalog refresh only invalidates scopes containing a changed repository. */
export function githubRepositoryScopeCurrent(
  connection: GitHubConnection | undefined,
  revision: number,
  repositoryIds: number[],
) {
  return (
    !!connection?.installationId &&
    revision >= githubConnectionRevision(connection) &&
    revision <= connection.revision &&
    repositoryIds.every(
      (id) => revision >= (connection.repositoryRevisions?.[id] ?? 0),
    )
  );
}
export interface GitHubPage {
  configured: boolean;
  canRegister?: boolean;
  appSlug?: string;
  appSettingsUrl?: string;
  installUrl?: string;
  connection?: GitHubConnection;
  refreshError?: string;
  revision: number;
  pending: boolean;
  login?: string;
  installations: GitHubInstallation[];
}
