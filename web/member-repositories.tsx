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

export function MemberRepositories({
  login,
  repositories,
}: {
  login: string;
  repositories: Repository[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {repositories.length > 0 && (
        <ul
          className="repository-list repository-list-stacked"
          aria-label="Repository access"
        >
          {repositories.slice(0, 5).map((repository) => (
            <li className="repository-list-item" key={repository.id}>
              <RepositoryCard
                compact
                name={repository.full_name}
                metadata={
                  <span className="pill">{permission(repository)}</span>
                }
              />
            </li>
          ))}
        </ul>
      )}
      {repositories.length > 5 && (
        <button
          type="button"
          className="secondary member-repositories-action"
          aria-label={`Show all ${repositories.length} repositories for ${login}`}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          Show all ({repositories.length})
        </button>
      )}
      {open && (
        <Modal title={`${login} repositories`} onClose={() => setOpen(false)}>
          <p className="muted">{repositories.length} repositories</p>
          <ul className="repository-list" aria-label="Repository access">
            {repositories.map((repository) => (
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
        </Modal>
      )}
    </>
  );
}
