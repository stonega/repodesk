import { type Member, requireThat, type Workspace } from "../domain.ts";
import type { GitHubMember } from "./app.ts";

export function availableGitHubAccount(
  w: Workspace,
  actor: string,
  id: number,
) {
  requireThat(
    !w.members.some(
      (m) =>
        m.id !== actor && (m.github?.id === id || m.githubAccount?.id === id),
    ),
    "github_identity_already_linked",
    409,
  );
}

/** Admin associations are profile data; only member OAuth creates access snapshots. */
export function assignGitHubAccount(
  w: Workspace,
  member: Member,
  account: GitHubMember | null,
) {
  requireThat(
    !member.github || member.github.id === account?.id,
    "github_verified_account_requires_member_reconnect",
    409,
  );
  if (account) {
    availableGitHubAccount(w, member.id, account.id);
    member.githubAccount = { id: account.id, login: account.login };
  } else delete member.githubAccount;
}
