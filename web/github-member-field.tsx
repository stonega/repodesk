import { useEffect, useState } from "react";
import type { GitHubMember, GitHubMemberDirectory } from "../src/github/app.ts";
import { Select } from "./select.tsx";

type Request = <T>(
  path: string,
  method?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>;

export function GitHubMemberField({
  workspaceId,
  request,
  account,
  verified,
  value,
  onChange,
}: {
  workspaceId: string;
  request: Request;
  account?: GitHubMember;
  verified: boolean;
  value: string;
  onChange: (value: string, revision: number) => void;
}) {
  const [directory, setDirectory] = useState<GitHubMemberDirectory>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    void retry;
    const controller = new AbortController();
    setDirectory(undefined);
    setLoading(true);
    setError("");
    request<GitHubMemberDirectory>(
      `/api/admin/workspaces/${workspaceId}/members/github`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setDirectory(result);
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted)
          setError(
            error.message.includes("github_members_permission_missing")
              ? "Enable Members: read in the GitHub App's organization permissions and approve the updated installation, then try again."
              : "Could not fetch GitHub members. Try again or check the workspace's GitHub connection.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [workspaceId, request, retry]);
  const choices = directory?.members ?? [];
  const selectedAccount =
    choices.find((m) => String(m.id) === value) ??
    (String(account?.id) === value ? account : undefined);
  return (
    <div className="field">
      <label htmlFor="member-github-account">GitHub account</label>
      <Select
        id="member-github-account"
        value={value}
        disabled={verified || loading || !directory?.connected}
        onChange={(event) => {
          if (directory) onChange(event.target.value, directory.revision);
        }}
      >
        <option value="">Not linked</option>
        {account && !choices.some((m) => m.id === account.id) && (
          <option value={String(account.id)}>{account.login}</option>
        )}
        {choices.map((m) => (
          <option key={m.id} value={String(m.id)}>
            {m.login}
          </option>
        ))}
      </Select>
      {loading && (
        <p className="muted" role="status">
          Fetching GitHub members…
        </p>
      )}
      {error && (
        <>
          <p className="notice" role="alert">
            {error}
          </p>
          <button
            className="secondary"
            type="button"
            onClick={() => setRetry((n) => n + 1)}
          >
            Try again
          </button>
        </>
      )}
      {directory && !directory.connected && (
        <p className="muted">
          Connect this workspace to GitHub from Overview to fetch members.
        </p>
      )}
      {directory?.connected && !verified && (
        <p className="muted">
          {directory.source === "organization"
            ? `Members fetched from ${directory.account}.`
            : `Owner and collaborators fetched from ${directory.account}'s selected repositories.`}{" "}
          Choose this person's account. They can verify it with /github connect
          in Telegram.
        </p>
      )}
      {verified && (
        <p className="muted">
          This account was verified through Telegram. The member can change it
          with /github connect.
        </p>
      )}
      {selectedAccount && (
        <a
          href={`https://github.com/${selectedAccount.login}`}
          target="_blank"
          rel="noreferrer"
        >
          View {selectedAccount.login} on GitHub
        </a>
      )}
    </div>
  );
}
