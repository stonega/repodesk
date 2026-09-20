import type { GitHubInstallation, GitHubRepository } from "./app.ts";
export type GitHubConnection = {
  revision: number;
  installationId?: number;
  account?: string;
  connectedBy?: string;
  connectedAt?: string;
  repositories: GitHubRepository[];
};
export interface GitHubPage {
  configured: boolean;
  canRegister?: boolean;
  appSlug?: string;
  installUrl?: string;
  connection?: GitHubConnection;
  revision: number;
  pending: boolean;
  login?: string;
  installations: GitHubInstallation[];
}
