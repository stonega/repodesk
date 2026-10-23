import { z } from "zod";
import { Fault, requireThat, type Workspace } from "../domain.ts";
import type { GitHubApp } from "../github/app.ts";
import { githubConnectionRevision } from "../github/config.ts";
import {
  authorizeVerifiedRepository,
  githubAccessPending,
} from "../github/user-access.ts";
import { branchName } from "./config.ts";
import type { DevelopmentInput, DevelopmentTask } from "./development.ts";

export const referenceSource = z.object({
  repositoryId: z.number().int().positive(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  installationId: z.number().int().positive(),
  connectionRevision: z.number().int().nonnegative(),
  repositoryRevision: z.number().int().nonnegative(),
  ref: branchName,
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  revision: z.number().int().positive(),
});
export type ReferenceSource = z.infer<typeof referenceSource>;
export const referencePath = (source: Pick<ReferenceSource, "repositoryId">) =>
  `/task/references/${source.repositoryId}`;

export function checkReferenceSources(
  w: Workspace,
  task: DevelopmentTask,
  actors: string[],
) {
  for (const source of task.referenceSources ?? []) {
    const repository = w.github?.repositories.find(
      (r) => r.id === source.repositoryId,
    );
    requireThat(
      w.github?.installationId === source.installationId &&
        githubConnectionRevision(w.github) === source.connectionRevision &&
        (w.github.repositoryRevisions?.[source.repositoryId] ?? 0) ===
          source.repositoryRevision &&
        repository?.full_name === source.repository &&
        !repository.archived &&
        !repository.disabled,
      "coding_reference_source_changed",
      409,
    );
    for (const actor of actors)
      authorizeVerifiedRepository(w, actor, source.repositoryId);
  }
}

function mentions(text: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w./-])${escaped}(?![\\w./-])`, "i").test(text);
}

function linksRepository(text: string, repository: string) {
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `https://github\\.com/${escaped}(?:\\.git)?(?=[/?#\\s)>]|$)`,
    "i",
  ).test(text);
}

/** Only authenticated task inputs can select an additional readable repository. */
export function requestedReferences(
  w: Workspace,
  task: DevelopmentTask,
  inputs: DevelopmentInput[],
) {
  const repositories = w.github?.repositories ?? [];
  const text = inputs.map((input) => input.text).join("\n");
  const requested = repositories.filter((repository) => {
    if (repository.id === task.payload.repositoryId) return false;
    const name = repository.full_name.split("/")[1] ?? "";
    return (
      mentions(text, repository.full_name) ||
      linksRepository(text, repository.full_name) ||
      (repositories.filter(
        (r) => r.full_name.split("/")[1]?.toLowerCase() === name.toLowerCase(),
      ).length === 1 &&
        mentions(text, name))
    );
  });
  requireThat(requested.length <= 4, "coding_reference_source_limit", 409);
  for (const repository of requested) {
    requireThat(
      !repository.archived && !repository.disabled,
      "coding_reference_source_unavailable",
      409,
    );
    for (const actor of new Set(inputs.map((input) => input.actor)))
      authorizeVerifiedRepository(w, actor, repository.id);
  }
  return requested;
}

export async function pinReferenceSources(
  w: Workspace,
  task: DevelopmentTask,
  inputs: DevelopmentInput[],
  app: GitHubApp,
) {
  const requested = requestedReferences(w, task, inputs);
  if (!requested.length) return [];
  requireThat(w.github?.installationId, "github_repository_not_connected", 409);
  const retained = new Map(
    (task.referenceSources ?? [])
      .filter(
        (source) =>
          task.phase !== "intake" || source.revision === task.revision,
      )
      .map((source) => [source.repositoryId, source]),
  );
  const missing = requested.filter(
    (repository) => !retained.has(repository.id),
  );
  if (!missing.length)
    return requested.map(
      (repository) => retained.get(repository.id) as ReferenceSource,
    );
  const { token } = await app.installationToken(
    w.github.installationId,
    missing.map((repository) => repository.id),
    "contents",
  );
  const sources: ReferenceSource[] = [];
  for (const repository of requested) {
    const prior = retained.get(repository.id);
    if (prior) {
      sources.push(prior);
      continue;
    }
    let ref: string;
    let commit: { sha: string };
    try {
      ref = branchName.parse(repository.default_branch);
      commit = z
        .object({ sha: referenceSource.shape.sha })
        .parse(
          await app.skillResource(
            token,
            repository.full_name,
            `commits/${encodeURIComponent(ref)}`,
          ),
        );
    } catch (error) {
      if (githubAccessPending(error)) throw error;
      throw new Fault("coding_reference_source_unavailable", 409);
    }
    sources.push({
      repositoryId: repository.id,
      repository: repository.full_name,
      installationId: w.github.installationId,
      connectionRevision: githubConnectionRevision(w.github),
      repositoryRevision: w.github.repositoryRevisions?.[repository.id] ?? 0,
      ref,
      sha: commit.sha,
      revision: task.revision,
    });
  }
  return sources;
}
