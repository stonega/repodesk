import { useState } from "react";
import type { Member } from "../src/domain.ts";
import { Modal } from "./modal.tsx";
import { RepositoryCard } from "./repository-card.tsx";

type Repository = NonNullable<Member["github"]>["repositories"][number];

function permission(repository: Repository) {
  const access = repository.permissions;
  return access?.admin
    ? "Admin"
    : access?.maintain
      ? "Maintain"
      : access?.push
        ? "Write"
        : access?.triage
          ? "Triage"
          : "Read";
}

export function MemberGitHub({
  member,
  disabled = false,
}: {
  member: Member;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const github = member.github;
  const account = github ?? member.githubAccount;
  const title = `${account?.login ?? member.name ?? member.id} GitHub`;
  return (
    <>
      <button
        type="button"
        className="secondary"
        aria-label={`View GitHub for member ${member.id}`}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        View
      </button>
      {open && (
        <Modal title={title} onClose={() => setOpen(false)}>
          {account ? (
            <>
              <a
                href={`https://github.com/${account.login}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <strong>{account.login}</strong>
              </a>
              <p className="muted">
                {github ? (
                  <>
                    {github.status} · Synced{" "}
                    {new Date(github.syncedAt).toLocaleString()}
                  </>
                ) : (
                  "Verification pending"
                )}
              </p>
            </>
          ) : (
            <p className="muted">Not linked</p>
          )}
          {github && (
            <>
              <p className="muted">
                {github.repositories.length === 0
                  ? "No repository access."
                  : `${github.repositories.length} ${github.repositories.length === 1 ? "repository" : "repositories"}`}
              </p>
              {github.repositories.length > 0 && (
                <ul className="repository-list" aria-label="Repository access">
                  {github.repositories.map((repository) => (
                    <li className="repository-list-item" key={repository.id}>
                      <RepositoryCard
                        compact
                        name={repository.full_name}
                        url={`https://github.com/${repository.full_name}`}
                        metadata={
                          <span className="pill">{permission(repository)}</span>
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
