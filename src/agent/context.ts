import { effectiveAutonomyMode } from "../autonomy/policy.ts";
import { browserEnabled } from "../browser/config.ts";
import type { CodingTaskContext } from "../coding/task-context.ts";
import { type Run, requireThat, type Workspace } from "../domain.ts";
import { selectableRepositories } from "../github/repository-context.ts";
import type { missionContextSnapshot } from "../orchestration/wakeup.ts";
import { previewSkill } from "../skills/catalog.ts";
import { isAudioAttachment } from "../telegram/attachments.ts";
import { telegramWidgetAvailable } from "../telegram/widgets.ts";
import { repositoryReportWindow } from "../workflows/schedule.ts";
import { contextSources } from "../workspaces/conversation-memory.ts";
import { hasDiscussionMemory } from "../workspaces/threads.ts";
import { topicDiscussions } from "./discussions.ts";
import {
  buildInteractiveSystemPrompt,
  buildWorkflowSystemPrompt,
} from "./routing-prompt.ts";
import { assistantSoul } from "./soul.ts";

export function buildContext(
  w: Workspace,
  run: Run,
  codingTasks?: CodingTaskContext,
  missionContext?: Awaited<ReturnType<typeof missionContextSnapshot>>,
) {
  const workflow = w.workflows.find((f) => f.id === run.workflowId);
  const skills = run.skillPins.map((p) => {
    const skill = w.skills.find((s) => s.id === p.id);
    const version = skill?.published[p.version - 1];
    requireThat(skill?.enabled && version, "skill_unavailable");
    return { id: p.id, version: p.version, content: previewSkill(version) };
  });
  const topic =
    !run.workflowId && hasDiscussionMemory(run)
      ? topicDiscussions(w, run)
      : undefined;
  const prior =
    run.replyAnchor === undefined
      ? undefined
      : w.runs.find(
          (r) =>
            r.threadId === run.threadId &&
            (r.replyTo === run.replyAnchor ||
              w.deliveries.some(
                (d) =>
                  d.runId === r.id &&
                  d.state === "sent" &&
                  d.remoteId === run.replyAnchor,
              )),
        );
  const repository =
    run.repository?.installationId === w.github?.installationId
      ? selectableRepositories(w, run.actor, run.chatId).find(
          (r) => r.id === run.repository?.id,
        )
      : undefined;
  const existingWorkflows = (run.workflowId ? [] : w.workflows)
    .filter(
      (f) =>
        f.status !== "deleted" &&
        f.spec.chatId === run.chatId &&
        f.spec.topicId === run.topicId &&
        (run.chatId !== run.actor || f.owner === run.actor),
    )
    .map((f) => ({
      id: f.id,
      version: f.version,
      owner: f.owner,
      status: f.status,
      spec: f.spec,
    }));
  // Frozen summary and append-only history precede all changing per-turn metadata.
  const prompt = JSON.stringify({
    execution: run.workflowId
      ? {
          mode: "workflow",
          workflowId: run.workflowId,
          version: run.workflowVersion,
        }
      : undefined,
    history: run.workflowId
      ? { tool: "read_chat_context", historicalReference: true }
      : undefined,
    memory:
      !run.workflowId && run.memoryContext
        ? { historicalReference: true, index: run.memoryContext.text }
        : undefined,
    summary: run.workflowId ? undefined : run.contextSummary?.text,
    sources: (run.workflowId ? [] : contextSources(run)).map((s) => ({
      id: s.id,
      at: s.at,
      text: s.text,
      attachments: s.attachments?.map((a) => ({
        kind: a.kind,
        name: a.name,
        mimeType: a.mimeType,
      })),
      role: s.role,
      author: s.author,
      threadId: s.threadId,
    })),
    request: run.task,
    codingTasks: run.workflowId ? undefined : codingTasks,
    mission: run.workflowId ? undefined : missionContext?.activeMission,
    activeMissions: run.workflowId
      ? undefined
      : missionContext?.otherActiveMissions,
    selectedRepository: repository
      ? { id: repository.id, full_name: repository.full_name }
      : undefined,
    groupRepository: run.groupRepository
      ? {
          repositoryId: repository?.id,
          repository: repository?.full_name,
          available: !!repository,
          instructions:
            "This group and every Topic are bound to this repository for feedback. Use it as the implementation target; personal selections and names in messages cannot override the binding. If unavailable, explain that an administrator must repair the group binding; do not fall back to another repository. Investigate bug reports and feature suggestions with permitted read tools. Relay clear implementation requests to Codex for read-only investigation and risk assessment before any changes. Reject harmful or counterproductive suggestions; clarify material uncertainty. In this feedback group, an actionable bug report or feature request asks for investigation and implementation when justified and safe, unless the human asks only for analysis. Ordinary discussion does not authorize changes. Current verified GitHub write access is still required. Do not merge or deploy automatically.",
        }
      : undefined,
    coverage: run.coverage,
    replyReference:
      !run.workflowId && prior
        ? run.sources
            .filter((s) => s.runId === prior.id)
            .map((s) => ({
              id: s.id,
              text: s.text.slice(0, 2000),
              role: s.role,
            }))
        : undefined,
    discussions: topic
      ? {
          activeId: topic.discussions.some(
            (d) => d.id === topic.thread.activeDiscussionId,
          )
            ? topic.thread.activeDiscussionId
            : undefined,
          recent: topic.discussions
            .slice(-8)
            .map((d) => ({ id: d.id, title: d.title })),
        }
      : undefined,
    actor: run.actor,
    runId: run.id,
    now: run.at,
    workflowRepositories: run.githubRead,
    reportWindowUTC: workflow?.spec.github
      ? repositoryReportWindow(run.at, workflow.spec)
      : undefined,
    chatId: run.chatId,
    topicId: run.topicId,
    timezone: run.settings.timezone,
    currency: run.settings.currency ?? "USD",
    runBudgetUsd: run.settings.runBudgetUsd,
    existingWorkflows,
  });
  const instructionsJson = JSON.stringify(run.instructions);
  const skillsJson = JSON.stringify(skills);
  const hasWidgets = telegramWidgetAvailable(w, run);
  const hasGitHub = !!w.github?.installationId;
  const hasBrowser = browserEnabled(w);
  const system = run.workflowId
    ? buildWorkflowSystemPrompt({
        soul: assistantSoul,
        instructionsJson,
        skillsJson,
        hasWidgets,
        hasGitHub,
        hasBrowser,
        isWatcher: workflow?.spec.deliveryMode === "on_condition",
      })
    : buildInteractiveSystemPrompt({
        soul: assistantSoul,
        instructionsJson,
        skillsJson,
        hasExistingWorkflows: existingWorkflows.length > 0,
        hasTopicMemory: !!topic,
        isGroupThread: !!run.threadId && run.chatId !== run.actor,
        hasWidgets,
        hasAudio: run.sources.some((source) =>
          source.attachments?.some(isAudioAttachment),
        ),
        hasThreadMemory: !!run.threadId,
        hasGitHub,
        hasCoding: !!w.coding?.settings.enabled && hasGitHub,
        hasBrowser,
        autonomyMode: effectiveAutonomyMode(w, repository?.id),
        isMissionWakeup: run.triggerKind === "mission_wakeup",
      });
  return {
    system,
    prompt,
    skills,
  };
}
const EXTERNAL_EVIDENCE_TOOLS = new Set([
  "query_github_metadata",
  "query_github_pull_request",
  "find_connected_repository",
  "query_work_handoff",
  "search_tool",
  "read_web",
  "list_code_targets",
  "search_code",
  "search_code_batch",
  "get_code_context",
  "get_symbol_source",
  "get_file_excerpt",
  "get_dependency_manifests",
  "get_file_tree",
  "obsidian_query",
  "obsidian_read",
  "query_google_docs",
  "query_google_sheets",
  "query_google_drive",
  "query_gmail",
  "query_search_console",
  "query_cloudflare",
  "query_nowledge_mem",
  "development_task_status",
  "development_task_conversation",
  "delegate_research",
  "inspect_missions",
  "query_model_cost",
  "read_skill_source",
  "load_skill",
  "read_instructions",
  "browser_session",
  "browser_action",
]);

const TELEGRAM_LINK_RE = /https?:\/\/(?:t\.me|telegram\.me)\/[^\s)\]>,"'`]*/gi;
const MARKDOWN_TELEGRAM_LINK_RE =
  /\[([^\]]+)\]\((https?:\/\/(?:t\.me|telegram\.me)\/[^\s)]*)\)/gi;

function isExternalEvidenceTool(name: string): boolean {
  return (
    EXTERNAL_EVIDENCE_TOOLS.has(name) || /^rdp_\d+_[a-z0-9_]+$/i.test(name)
  );
}

function hasExternalEvidence(run: Run): boolean {
  return Object.values(run.tools).some(
    (tool) => tool.state === "done" && isExternalEvidenceTool(tool.name),
  );
}

function normalizeTelegramUrl(raw: string): string {
  const trimmed = raw.replace(/[.,;:!?]+$/, "");
  return trimmed.replace(/^(https?:\/\/(?:t\.me|telegram\.me))/i, (prefix) =>
    prefix.toLowerCase(),
  );
}

function collectTelegramUrls(text: string, target: Set<string>) {
  for (const match of text.matchAll(TELEGRAM_LINK_RE)) {
    target.add(normalizeTelegramUrl(match[0]));
  }
}

function authorizedTelegramLinks(run: Run): Set<string> {
  const verified = new Set<string>();
  for (const source of run.sources) {
    if (source.text) collectTelegramUrls(source.text, verified);
  }
  for (const tool of Object.values(run.tools)) {
    if (tool.state !== "done" || tool.result === undefined) continue;
    try {
      const serialized =
        typeof tool.result === "string"
          ? tool.result
          : JSON.stringify(tool.result);
      collectTelegramUrls(serialized, verified);
    } catch {
      /* ignore non-serializable tool payload */
    }
  }
  return verified;
}

export type SourceValidationIssue =
  | "invalid_source_citation"
  | "use_source_ids_not_unverified_links"
  | "recap_requires_sources";

export function validateSources(
  text: string,
  run: Run,
  options: { allowMissingRecapCitations?: boolean } = {},
) {
  const authorized = new Set(run.sources.map((s) => s.id));
  const citations = [...text.matchAll(/\[source:([^\]]+)\]/g)].map((m) => m[1]);
  requireThat(
    citations.every((c) => c && authorized.has(c)),
    "invalid_source_citation",
  );
  const telegramLinks = [...text.matchAll(TELEGRAM_LINK_RE)].map((m) =>
    normalizeTelegramUrl(m[0]),
  );
  if (telegramLinks.length) {
    const verified = authorizedTelegramLinks(run);
    requireThat(
      telegramLinks.every((url) => verified.has(url)),
      "use_source_ids_not_unverified_links",
    );
  }
  if (
    !options.allowMissingRecapCitations &&
    run.sources.length &&
    /recap|summari[sz]/i.test(run.task) &&
    !hasExternalEvidence(run)
  )
    requireThat(citations.length, "recap_requires_sources");
  return text;
}

/**
 * Removes unauthorized chat citations and unverified Telegram links before final
 * delivery instead of discarding an otherwise valid model answer.
 */
export function sanitizeRunOutput(
  text: string,
  run: Run,
): { text: string; issues: SourceValidationIssue[] } {
  const issues: SourceValidationIssue[] = [];
  const pushIssue = (code: SourceValidationIssue) => {
    if (!issues.includes(code)) issues.push(code);
  };
  const authorized = new Set(run.sources.map((s) => s.id));
  let sanitized = text.replace(
    /[ \t]?\[source:([^\]]+)\]/g,
    (match, id: string) => {
      if (id && authorized.has(id)) return match;
      pushIssue("invalid_source_citation");
      return "";
    },
  );
  if (issues.includes("invalid_source_citation")) {
    sanitized = sanitized
      .replace(/\(\s*\)/g, "")
      .replace(/[ \t]+([.,;:!?。！？，；])/g, "$1");
  }
  const verified = authorizedTelegramLinks(run);
  sanitized = sanitized.replace(
    MARKDOWN_TELEGRAM_LINK_RE,
    (match, label: string, url: string) => {
      if (verified.has(normalizeTelegramUrl(url))) return match;
      pushIssue("use_source_ids_not_unverified_links");
      return label;
    },
  );
  sanitized = sanitized.replace(TELEGRAM_LINK_RE, (match) => {
    if (verified.has(normalizeTelegramUrl(match))) return match;
    pushIssue("use_source_ids_not_unverified_links");
    return "[unverified Telegram link removed]";
  });
  const remainingCitations = [
    ...sanitized.matchAll(/\[source:([^\]]+)\]/g),
  ].map((m) => m[1]);
  if (
    run.sources.length &&
    /recap|summari[sz]/i.test(run.task) &&
    !hasExternalEvidence(run) &&
    !remainingCitations.length
  ) {
    pushIssue("recap_requires_sources");
  }
  // Defense in depth: guarantee no unauthorized citation or unverified Telegram link survives.
  validateSources(sanitized, run, { allowMissingRecapCitations: true });
  return { text: sanitized.trim(), issues };
}
