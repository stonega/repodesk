import { requireThat, type Workspace } from "../domain.ts";

/** Check the human's quoted target independently of the model's numeric ID. */
export function requireRepositoryTarget(
  w: Workspace,
  repositoryId: number,
  texts: string[],
  target: string,
) {
  const mention = target.trim().toLowerCase();
  // An empty quote means the target comes from retained conversation context.
  if (!mention) return;
  const tokens = texts.flatMap(
    (text) =>
      text
        // A document/issue URL is reference material. A bare repo URL can name a target.
        .replace(/https?:\/\/[^\s<>"`\])]+/gi, (url) => {
          const root = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/?$/i.exec(
            url,
          );
          return root ? ` ${root[1]?.replace(/\.git$/i, "")} ` : " ";
        })
        .toLowerCase()
        .match(/[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)?/g) ?? [],
  );
  requireThat(
    tokens.includes(mention),
    "coding_repository_target_unverified",
    409,
  );
  const repositories = w.github?.repositories ?? [];
  const exact = repositories.filter((repo) =>
    mention.includes("/")
      ? repo.full_name.toLowerCase() === mention
      : repo.full_name.split("/")[1]?.toLowerCase() === mention,
  );
  // Accept an unambiguous abbreviation such as product-land; never edit-distance guess.
  const matches = exact.length
    ? exact
    : repositories.filter(
        (repo) =>
          !mention.includes("/") &&
          mention.length >= 4 &&
          repo.full_name.split("/")[1]?.toLowerCase().startsWith(mention),
      );
  requireThat(matches.length === 1, "coding_repository_target_ambiguous", 409);
  requireThat(
    matches[0]?.id === repositoryId,
    "coding_repository_target_mismatch",
    409,
  );
}
