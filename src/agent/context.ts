import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { effectiveAutonomyMode } from "../autonomy/policy.ts";
import { browserEnabled } from "../browser/config.ts";
import { codingEnabled } from "../coding/config.ts";
import type { CodingTaskContext } from "../coding/task-context.ts";
import {
  type Run,
  requireThat,
  type Source,
  type Workspace,
} from "../domain.ts";
import { selectableRepositories } from "../github/repository-context.ts";
import type { missionContextSnapshot } from "../orchestration/wakeup.ts";
import {
  isPresetSkill,
  previewSkill,
  previewSkillIndex,
} from "../skills/catalog.ts";
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

function formatSourceBlock(source: Source, includeAuthor: boolean): string {
  const metaParts = [`[source:${source.id}]`];
  if (includeAuthor && source.author) metaParts.push(`author:${source.author}`);
  if (source.at) metaParts.push(source.at);
  if (source.attachments?.length) {
    const names = source.attachments
      .map((a) => `${a.kind}${a.name ? `:${a.name}` : ""}`)
      .join(", ");
    metaParts.push(`attachments:${names}`);
  }
  const header = metaParts.join(" ");
  return source.text ? `${header}\n${source.text}` : header;
}

function historyAssistantMessage(
  text: string,
  timestamp: number,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "history",
    model: "history",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

/**
 * Converts frozen reference context (long-term memory + compacted summary) and
 * prior conversation sources into native alternating user/assistant messages.
 *
 * Strictly append-only across turns so [system, tools, ...historyMessages] stays
 * byte-identical as a prompt-cache prefix while preserving native turn structure.
 */
function buildHistoryMessages(
  run: Run,
  priorSources: Source[],
  isGroup: boolean,
): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const referenceSections: string[] = [];
  if (run.memoryContext?.text) {
    referenceSections.push(
      `## Long-Term Memory Index (untrusted historical reference)\n${run.memoryContext.text}`,
    );
  }
  if (run.contextSummary?.text) {
    referenceSections.push(
      `## Earlier Conversation Summary (untrusted historical reference)\n${run.contextSummary.text}`,
    );
  }
  if (referenceSections.length > 0) {
    const refMsg: UserMessage = {
      role: "user",
      content: referenceSections.join("\n\n"),
      timestamp: 0,
    };
    messages.push(refMsg);
    // Keep strict user/assistant alternation when the first prior source is also a user turn.
    if (priorSources.length > 0 && priorSources[0]?.role !== "assistant") {
      messages.push(
        historyAssistantMessage(
          "Acknowledged historical reference context.",
          0,
        ),
      );
    }
  }

  for (const source of priorSources) {
    const ts = Date.parse(source.at) || 0;
    const isAssistant = source.role === "assistant";
    if (isAssistant) {
      const text = source.text || "(empty response)";
      const prev = messages.at(-1);
      if (prev?.role === "assistant") {
        const prevText = prev.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        messages[messages.length - 1] = historyAssistantMessage(
          `${prevText}\n\n${text}`,
          ts,
        );
      } else {
        messages.push(historyAssistantMessage(text, ts));
      }
    } else {
      const block = formatSourceBlock(source, isGroup);
      const prev = messages.at(-1);
      if (prev?.role === "user" && typeof prev.content === "string") {
        messages[messages.length - 1] = {
          ...prev,
          content: `${prev.content}\n\n${block}`,
          timestamp: ts,
        };
      } else {
        messages.push({
          role: "user",
          content: block,
          timestamp: ts,
        });
      }
    }
  }

  // If history ends on a user turn (e.g. unanswered earlier turn), append a minimal
  // assistant bridge so the current user turn starts a clean user role.
  if (messages.at(-1)?.role === "user") {
    messages.push(
      historyAssistantMessage(
        "(No assistant reply was recorded for the message above.)",
        0,
      ),
    );
  }

  return messages;
}

export interface TurnContextMetadata {
  execution?: {
    mode: "workflow";
    workflowId: string;
    version?: number;
  };
  history?: { tool: string; historicalReference: true };
  memory?: { historicalReference: true; index: string };
  summary?: string;
  request: string;
  sources: {
    id: string;
    at: string;
    text: string;
    attachments?: { kind: string; name?: string; mimeType?: string }[];
    role?: "user" | "assistant";
    author: string;
    threadId?: string;
  }[];
  codingTasks?: CodingTaskContext;
  mission?: Awaited<ReturnType<typeof missionContextSnapshot>>["activeMission"];
  activeMissions?: Awaited<
    ReturnType<typeof missionContextSnapshot>
  >["otherActiveMissions"];
  selectedRepository?: { id: number; full_name: string };
  groupRepository?: {
    repositoryId?: number;
    repository?: string;
    available: boolean;
    instructions: string;
  };
  coverage: string;
  replyReference?: { id: string; text: string; role?: "user" | "assistant" }[];
  discussions?: {
    activeId?: string;
    recent: { id: string; title: string }[];
  };
  actor: string;
  runId: string;
  now: string;
  workflowRepositories?: Run["githubRead"];
  reportWindowUTC?: ReturnType<typeof repositoryReportWindow>;
  chatId: string;
  topicId: number;
  timezone: string;
  currency: string;
  runBudgetUsd: number | null;
  existingWorkflows: {
    id: string;
    version: number;
    owner: string;
    status: string;
    spec: Workspace["workflows"][number]["spec"];
  }[];
}

export function formatTurnPrompt(
  requestText: string,
  currentSources: Source[],
  runtimeMetadata: Record<string, unknown>,
  isGroup: boolean,
): string {
  const parts: string[] = [];
  if (currentSources.length > 0) {
    const renderedSources = currentSources
      .map((s) => formatSourceBlock(s, isGroup))
      .join("\n\n");
    const singleMatchingRequest =
      currentSources.length === 1 &&
      currentSources[0]?.text.trim() === requestText.trim();
    if (singleMatchingRequest) {
      parts.push(renderedSources);
    } else {
      parts.push(
        `## Current Message Sources (untrusted reference data)\n${renderedSources}\n\n## Current Request\n${requestText}`,
      );
    }
  } else {
    parts.push(requestText);
  }
  parts.push(
    `<runtime_context>\n${JSON.stringify(runtimeMetadata)}\n</runtime_context>`,
  );
  return parts.join("\n\n");
}

export function buildContext(
  w: Workspace,
  run: Run,
  codingTasks?: CodingTaskContext,
  missionContext?: Awaited<ReturnType<typeof missionContextSnapshot>>,
  options?: { requestOverride?: string },
) {
  const workflow = w.workflows.find((f) => f.id === run.workflowId);
  const resolvedPins = run.skillPins.map((p) => {
    const skill = w.skills.find((s) => s.id === p.id);
    const version = skill?.published[p.version - 1];
    requireThat(skill?.enabled && version, "skill_unavailable");
    return { pin: p, skill, version };
  });
  const progressiveInteractive =
    !run.workflowId &&
    (resolvedPins.length > 3 ||
      resolvedPins.some(
        ({ skill, version }) =>
          !!skill.auto || version.scope?.kind === "project",
      ));
  const skills: (
    | (ReturnType<typeof previewSkillIndex> & { content?: string })
    | { id: string; version: number; content: string }
  )[] = resolvedPins.map(({ pin, skill, version }) => {
    if (progressiveInteractive && !isPresetSkill(w, skill)) {
      return previewSkillIndex(w, skill, version, pin.version);
    }
    return {
      id: pin.id,
      version: pin.version,
      content: previewSkill(version),
    };
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

  const isGroup = run.chatId !== run.actor;
  const activeSources = run.workflowId ? [] : contextSources(run);
  // Separate completed historical turns (placed into native multi-turn historyMessages)
  // from sources belonging to the current run (placed in the final user turn).
  const priorSources = activeSources.filter(
    (s) => s.runId !== undefined && s.runId !== run.id,
  );
  const currentSources = activeSources.filter(
    (s) => s.runId === undefined || s.runId === run.id,
  );
  const historyMessages = run.workflowId
    ? []
    : buildHistoryMessages(run, priorSources, isGroup);

  const requestText = options?.requestOverride ?? run.task;
  const groupRepository = run.groupRepository
    ? {
        repositoryId: repository?.id,
        repository: repository?.full_name,
        available: !!repository,
        instructions:
          "This group and every Topic are bound to this repository for feedback. Use it as the implementation target; personal selections and names in messages cannot override the binding. If unavailable, explain that an administrator must repair the group binding; do not fall back to another repository. Investigate bug reports and feature suggestions with permitted read tools. Relay clear implementation requests to Codex for read-only investigation and risk assessment before any changes. Reject harmful or counterproductive suggestions; clarify material uncertainty. In this feedback group, an actionable bug report or feature request asks for investigation and implementation when justified and safe, unless the human asks only for analysis. Ordinary discussion does not authorize changes. Current verified GitHub write access is still required. Do not merge or deploy automatically.",
      }
    : undefined;
  const replyReference =
    !run.workflowId && prior
      ? run.sources
          .filter((s) => s.runId === prior.id)
          .map((s) => ({
            id: s.id,
            text: s.text.slice(0, 2000),
            role: s.role,
          }))
      : undefined;
  const discussions = topic
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
    : undefined;
  const execution = run.workflowId
    ? {
        mode: "workflow" as const,
        workflowId: run.workflowId,
        version: run.workflowVersion,
      }
    : undefined;
  const history = run.workflowId
    ? { tool: "read_chat_context", historicalReference: true as const }
    : undefined;
  const selectedRepository = repository
    ? { id: repository.id, full_name: repository.full_name }
    : undefined;
  const reportWindowUTC = workflow?.spec.github
    ? repositoryReportWindow(run.at, workflow.spec)
    : undefined;

  // Compact per-turn runtime metadata placed at the tail of the final user turn so
  // changing timestamps, run IDs or snapshots never bust the cached history prefix.
  const runtimeMetadata = {
    execution,
    history,
    codingTasks: run.workflowId ? undefined : codingTasks,
    mission: run.workflowId ? undefined : missionContext?.activeMission,
    activeMissions: run.workflowId
      ? undefined
      : missionContext?.otherActiveMissions,
    selectedRepository,
    groupRepository,
    coverage: run.coverage,
    replyReference,
    discussions,
    actor: run.actor,
    runId: run.id,
    now: run.at,
    workflowRepositories: run.githubRead,
    reportWindowUTC,
    chatId: run.chatId,
    topicId: run.topicId,
    timezone: run.settings.timezone,
    currency: run.settings.currency ?? "USD",
    runBudgetUsd: run.settings.runBudgetUsd,
    existingWorkflows: existingWorkflows.length ? existingWorkflows : undefined,
  };

  const prompt = formatTurnPrompt(
    requestText,
    currentSources,
    runtimeMetadata,
    isGroup,
  );

  const metadata: TurnContextMetadata = {
    execution,
    history,
    memory:
      !run.workflowId && run.memoryContext
        ? { historicalReference: true, index: run.memoryContext.text }
        : undefined,
    summary: run.workflowId ? undefined : run.contextSummary?.text,
    request: requestText,
    sources: activeSources.map((s) => ({
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
    codingTasks: run.workflowId ? undefined : codingTasks,
    mission: run.workflowId ? undefined : missionContext?.activeMission,
    activeMissions: run.workflowId
      ? undefined
      : missionContext?.otherActiveMissions,
    selectedRepository,
    groupRepository,
    coverage: run.coverage,
    replyReference,
    discussions,
    actor: run.actor,
    runId: run.id,
    now: run.at,
    workflowRepositories: run.githubRead,
    reportWindowUTC,
    chatId: run.chatId,
    topicId: run.topicId,
    timezone: run.settings.timezone,
    currency: run.settings.currency ?? "USD",
    runBudgetUsd: run.settings.runBudgetUsd,
    existingWorkflows,
  };

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
        isGroupThread: !!run.threadId && isGroup,
        hasWidgets,
        hasAudio: run.sources.some((source) =>
          source.attachments?.some(isAudioAttachment),
        ),
        hasThreadMemory: !!run.threadId,
        hasGitHub,
        hasCoding: codingEnabled(w) && hasGitHub,
        hasBrowser,
        autonomyMode: effectiveAutonomyMode(w, repository?.id),
        isMissionWakeup: run.triggerKind === "mission_wakeup",
      });
  return {
    system,
    historyMessages,
    prompt,
    metadata,
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
