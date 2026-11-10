import { Fault, requireThat, type Workspace } from "../domain.ts";
import { type GitHubApp, GitHubRateLimitError } from "../github/app.ts";
import { ReviewGitHub } from "../review-bot/github.ts";
import { reviewMention } from "../review-bot/mentions.ts";
import { fingerprint } from "../setup/credentials.ts";
import type { DevelopmentInput, DevelopmentTask } from "./development.ts";

export function boundDevelopmentPull(task: DevelopmentTask) {
  const binding = task.pullBinding;
  return !!(
    binding &&
    binding.installationId === task.payload.installationId &&
    binding.repositoryId === task.payload.repositoryId &&
    binding.number === task.pr?.number &&
    binding.branch === task.pr.branch
  );
}

/** External requirements retain their own provenance, never a fabricated chat message. */
export function developmentInputPresent(
  w: Workspace,
  task: DevelopmentTask,
  input: DevelopmentInput,
) {
  const source = input.github;
  if (source)
    return (
      boundDevelopmentPull(task) &&
      input.actor === task.actor &&
      !input.hasAttachments &&
      input.sourceId === `github:${source.kind}:${source.id}` &&
      Date.parse(source.expiresAt) > Date.now() &&
      w.members.some(
        (member) =>
          member.id === input.actor &&
          member.github?.id === source.githubId &&
          member.github.status === "connected",
      )
    );
  return w.messages.some(
    (message) =>
      message.id === input.sourceId &&
      message.author === input.actor &&
      (!input.hasAttachments || !!message.attachments?.length) &&
      message.chatId === task.chatId &&
      message.topicId === task.topicId &&
      Date.parse(message.expiresAt) > Date.now(),
  );
}

/** Current fix policy is rechecked inside the final execution/publication transaction. */
export function checkDevelopmentGitHubPolicy(
  w: Workspace,
  inputs: DevelopmentInput[],
) {
  for (const input of inputs) {
    if (!input.github) continue;
    requireThat(
      w.reviewBot?.revision === input.github.reviewRevision &&
        w.reviewBot.settings.enabled &&
        w.reviewBot.settings.acceptRequests &&
        w.reviewBot.settings.allowFixes,
      "review_configuration_changed",
      409,
    );
  }
}

/** Authorizing comments are reread without holding a workspace transaction. */
export async function verifyDevelopmentGitHubInputs(
  app: GitHubApp,
  token: string,
  w: Workspace,
  task: DevelopmentTask,
  inputs: DevelopmentInput[],
) {
  checkDevelopmentGitHubPolicy(w, inputs);
  const github = new ReviewGitHub(app, token, task.payload.repository);
  const context: string[] = [];
  for (const input of inputs) {
    const source = input.github;
    if (!source) continue;
    requireThat(
      developmentInputPresent(w, task, input),
      "coding_source_expired",
      409,
    );
    try {
      const current = await github.source(source.kind, source.id);
      const mention = reviewMention(current.body, `${app.config.slug}[bot]`);
      requireThat(
        current.user.id === source.githubId &&
          fingerprint(current.body) === source.hash &&
          mention?.mode === "fix" &&
          mention.text === input.text &&
          (source.kind === "issue"
            ? current.issue_url
            : current.pull_request_url) ===
            `https://api.github.com/repos/${task.payload.repository}/${source.kind === "issue" ? "issues" : "pulls"}/${task.pr?.number}`,
        "coding_github_source_changed",
        409,
      );
      context.push(JSON.stringify(current));
      if (current.in_reply_to_id) {
        const parent = await github.source("review", current.in_reply_to_id);
        requireThat(
          parent.pull_request_url ===
            `https://api.github.com/repos/${task.payload.repository}/pulls/${task.pr?.number}`,
          "coding_github_source_changed",
          409,
        );
        context.push(
          `Referenced review comment (data): ${JSON.stringify(parent)}`,
        );
      }
    } catch (error) {
      if (error instanceof GitHubRateLimitError) throw error;
      if (
        error instanceof Fault &&
        error.code === "coding_github_source_changed"
      )
        throw error;
      throw new Fault(
        error instanceof Fault && error.code === "github_access_denied"
          ? "coding_github_source_changed"
          : "coding_github_source_unavailable",
        409,
      );
    }
  }
  return context.join("\n").slice(0, 16000);
}
