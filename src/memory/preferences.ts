import { Type } from "typebox";
import { z } from "zod";
import {
  type Run,
  requireThat,
  type Source,
  type Workspace,
} from "../domain.ts";
import { verifiedRepositoryAccess } from "../github/user-access.ts";
import {
  memoryReferences,
  validMemory,
} from "../workspaces/conversation-memory.ts";
import { eligible } from "../workspaces/policy.ts";
import { preferenceSettings } from "./settings.ts";
import {
  hashMemory,
  memoryScope,
  memoryState,
  redactMemory,
  scopeActive,
  scopeKey,
  scopeSources,
} from "./state.ts";
import type { MemoryContext, PreferenceEntry } from "./types.ts";

const mutation = z
  .object({
    action: z.enum([
      "remember",
      "correct",
      "exception",
      "accept",
      "forget",
      "configure",
    ]),
    sourceId: z.string().min(1).max(500),
    preferenceId: z.string().max(100).optional(),
    expectedRevision: z.number().int().positive().optional(),
    repositoryId: z.number().int().positive().optional(),
    domain: z.string().min(1).max(100).optional(),
    derive: z.boolean().optional(),
    recall: z.enum(["off", "pi", "pi_and_coding"]).optional(),
  })
  .strict();
export const preferenceParameters = Type.Object(
  {
    action: Type.Union(
      ["remember", "correct", "exception", "accept", "forget", "configure"].map(
        (a) => Type.Literal(a),
      ),
    ),
    sourceId: Type.String(),
    preferenceId: Type.Optional(Type.String()),
    expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
    repositoryId: Type.Optional(Type.Integer()),
    domain: Type.Optional(Type.String()),
    derive: Type.Optional(Type.Boolean()),
    recall: Type.Optional(
      Type.Union([
        Type.Literal("off"),
        Type.Literal("pi"),
        Type.Literal("pi_and_coding"),
      ]),
    ),
  },
  { additionalProperties: false },
);
const prefixes = {
  remember: /^(?:remember preference|记住偏好|記住偏好)\s*[:：]/i,
  correct: /^(?:correct preference|纠正偏好|修正偏好)\s+/i,
  exception: /^(?:add preference exception|偏好例外|新增偏好例外)\s+/i,
  accept: /^(?:accept preference|接受偏好|确认偏好|確認偏好)\s+/i,
  forget: /^(?:forget preference|忘记偏好|忘記偏好)\s+/i,
  configure:
    /^(?:configure preference learning|配置偏好学习|設定偏好學習)\s*[:：]/i,
};

export function authorizePreferenceMutation(
  w: Workspace,
  r: Run,
  args: Record<string, unknown>,
) {
  const parsed = mutation.parse(args);
  const scope = memoryScope(w, r);
  requireThat(scope && eligible(w, r.actor), "memory_scope_denied", 403);
  const source = w.messages.find(
    (s) =>
      s.id === parsed.sourceId &&
      s.runId === r.id &&
      s.author === r.actor &&
      s.role === "user" &&
      s.chatId === r.chatId &&
      s.topicId === r.topicId &&
      s.threadId === r.threadId &&
      Date.parse(s.expiresAt) > Date.now() &&
      r.sources.some((known) => known.id === s.id),
  );
  requireThat(
    source &&
      prefixes[parsed.action].test(source.text) &&
      prefixes[parsed.action].test(r.task),
    "explicit_preference_request_required",
    403,
  );
  return { parsed, source, scope };
}

export function readablePreferences(w: Workspace, r: Run) {
  const scope = memoryScope(w, r);
  if (!scope || !eligible(w, r.actor) || !scopeActive(w, scope)) return [];
  const sources = scopeSources(w, scope, Date.now(), r.actor);
  return (w.memory?.preferences ?? []).filter(
    (p) =>
      p.status !== "superseded" &&
      scopeKey(p.scope) === scopeKey(scope) &&
      validMemory(p, sources) &&
      (!p.applicability.repositoryId ||
        verifiedRepositoryAccess(
          w,
          r.actor,
          p.applicability.repositoryId,
          false,
        )),
  );
}

export function managePreference(
  w: Workspace,
  r: Run,
  args: Record<string, unknown>,
) {
  const { parsed: a, source, scope } = authorizePreferenceMutation(w, r, args);
  const state = memoryState(w);
  r.memoryMutation = true;
  if (a.action === "configure") {
    requireThat(eligible(w, r.actor, true), "group_memory_admin_required", 403);
    requireThat(
      source.text.split(/[:：]/).slice(1).join(":").trim() ===
        `derive=${a.derive} recall=${a.recall}`,
      "explicit_preference_request_required",
      403,
    );
    state.preferenceSettings = {
      derive: a.derive ?? preferenceSettings(w).derive,
      recall: a.recall ?? preferenceSettings(w).recall,
    };
    state.indexes = [];
    delete r.memoryContext;
    return state.preferenceSettings;
  }
  requireThat(scopeActive(w, scope), "memory_disabled", 409);
  if (a.action === "forget") {
    const receipt = state.preferenceReceipts?.find(
      (receipt) =>
        receipt.sourceId === source.id &&
        receipt.preferenceId === a.preferenceId,
    );
    if (receipt) {
      requireThat(
        a.expectedRevision === receipt.revision,
        "memory_revision_conflict",
        409,
      );
      return { preferenceId: receipt.preferenceId, status: "forgotten" };
    }
  }
  const prior = a.preferenceId
    ? readablePreferences(w, r).find((p) => p.preferenceId === a.preferenceId)
    : undefined;
  if (a.action !== "remember") {
    requireThat(
      prior && source.text.includes(prior.preferenceId),
      "memory_not_found",
      404,
    );
    requireThat(
      scope.kind === "private" ||
        prior.authors.every((actor) => actor === r.actor) ||
        eligible(w, r.actor, true),
      "group_memory_owner_or_admin_required",
      403,
    );
  }
  const duplicate = state.preferences?.find(
    (p) =>
      p.sourceIds.includes(source.id) &&
      p.preferenceId === (prior?.preferenceId ?? p.preferenceId),
  );
  if (duplicate)
    return {
      preferenceId: duplicate.preferenceId,
      revision: duplicate.revision,
      status: duplicate.status,
      applicability: duplicate.applicability,
    };
  requireThat(
    !prior || a.expectedRevision === prior.revision,
    "memory_revision_conflict",
    409,
  );
  if (a.action === "forget" && prior) {
    const ids = new Set([
      ...prior.sourceIds,
      ...(state.preferences ?? [])
        .filter((p) => p.preferenceId === prior.preferenceId)
        .flatMap((p) => p.sourceIds),
    ]);
    state.forgotten.push({ scope, sourceIds: [...ids] });
    state.preferences = state.preferences?.filter(
      (p) => !p.sourceIds.some((id) => ids.has(id)),
    );
    state.cases = state.cases?.filter(
      (p) => !p.sourceIds.some((id) => ids.has(id)),
    );
    state.entries = state.entries.filter(
      (p) => !p.sourceIds.some((id) => ids.has(id)),
    );
    state.indexes = [];
    state.preferenceReceipts = [
      ...(state.preferenceReceipts ?? []),
      {
        sourceId: source.id,
        preferenceId: prior.preferenceId,
        revision: prior.revision,
      },
    ];
    delete r.memoryContext;
    return { preferenceId: prior.preferenceId, status: "forgotten" };
  }
  const remainder = source.text.replace(prefixes[a.action], "").trim();
  const afterId =
    prior && remainder.startsWith(prior.preferenceId)
      ? remainder.slice(prior.preferenceId.length).trim()
      : remainder;
  const text =
    a.action === "remember" ? remainder : afterId.replace(/^[:：]\s*/, "");
  requireThat(
    !["correct", "exception"].includes(a.action) || /^[:：]/.test(afterId),
    "explicit_preference_request_required",
    403,
  );
  requireThat(
    a.action === "accept" ||
      (!!text && text.length <= 2000 && redactMemory(text) === text),
    "memory_statement_required",
    403,
  );
  if (a.repositoryId) {
    const repo = w.github?.repositories.find(
      (repo) => repo.id === a.repositoryId,
    );
    requireThat(
      repo &&
        source.text.includes(repo.full_name) &&
        verifiedRepositoryAccess(w, r.actor, repo.id, false),
      "memory_repository_denied",
      403,
    );
  }
  requireThat(
    !a.domain || source.text.toLowerCase().includes(a.domain.toLowerCase()),
    "memory_applicability_unverified",
    403,
  );
  requireThat(
    state.entries.length +
      (state.preferences?.length ?? 0) +
      (state.cases?.length ?? 0) <
      256,
    "memory_capacity_reached",
    409,
  );
  const preferenceId =
    prior?.preferenceId ??
    `pref:${hashMemory([w.id, scopeKey(scope), source.id]).slice(0, 32)}`;
  const sources = scopeSources(w, scope).filter(
    (s) => s.id === source.id || prior?.sourceIds.includes(s.id),
  );
  const next: PreferenceEntry = {
    createdAt: source.at,
    previousRevision: prior?.revision,
    correctionActor: prior ? r.actor : undefined,
    correctionSourceId: prior ? source.id : undefined,
    id: `${preferenceId}:${(prior?.revision ?? 0) + 1}`,
    preferenceId,
    revision: (prior?.revision ?? 0) + 1,
    status: "active_reference",
    evidence: "explicit",
    scope,
    threadId: r.threadId as string,
    authors: [...new Set([...(prior?.authors ?? []), r.actor])],
    title: "User preference",
    summary:
      a.action === "accept" || a.action === "exception"
        ? (prior?.summary ?? text)
        : text,
    applicability: {
      ...(prior?.applicability ?? {}),
      ...(a.repositoryId ? { repositoryId: a.repositoryId } : {}),
      ...(a.domain ? { domain: a.domain } : {}),
    },
    exceptions: [
      ...(prior?.exceptions ?? []),
      ...(a.action === "exception" ? [text] : []),
    ],
    updatedAt: new Date().toISOString(),
    usageCount: 0,
    explicit: true,
    ...memoryReferences(sources),
  };
  if (prior) prior.status = "superseded";
  for (const other of state.preferences ?? [])
    if (
      other.status === "active_reference" &&
      scope.kind === "group" &&
      scopeKey(other.scope) === scopeKey(scope) &&
      hashMemory([
        other.applicability.repositoryId ?? null,
        other.applicability.domain ?? null,
        other.applicability.taskId ?? null,
      ]) ===
        hashMemory([
          next.applicability.repositoryId ?? null,
          next.applicability.domain ?? null,
          next.applicability.taskId ?? null,
        ]) &&
      other.summary !== next.summary &&
      !other.authors.every((actor) => next.authors.includes(actor))
    ) {
      other.status = "disputed";
      next.status = "disputed";
    }
  state.preferences = [...(state.preferences ?? []), next];
  state.indexes = [];
  delete r.memoryContext;
  return {
    preferenceId,
    revision: next.revision,
    status: next.status,
    applicability: next.applicability,
  };
}

export function preferencePack(
  w: Workspace,
  r: Run,
  repositoryId?: number,
  coding = false,
): MemoryContext | undefined {
  const settings = preferenceSettings(w);
  if (
    settings.recall === "off" ||
    (coding && settings.recall !== "pi_and_coding")
  )
    return;
  const eligible = readablePreferences(w, r)
    .filter(
      (p) =>
        p.status === "active_reference" &&
        (!p.applicability.repositoryId ||
          p.applicability.repositoryId === repositoryId) &&
        (!p.applicability.taskId ||
          p.applicability.taskId === r.codingTaskId ||
          p.applicability.taskId === r.id) &&
        (!p.applicability.domain ||
          r.task.toLowerCase().includes(p.applicability.domain.toLowerCase())),
    )
    .sort(
      (a, b) =>
        Number(!!b.applicability.repositoryId) -
          Number(!!a.applicability.repositoryId) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id),
    );
  const selected: PreferenceEntry[] = [];
  const text: string[] = [];
  let used = 0;
  for (const p of eligible) {
    const line = `[preference:${p.preferenceId}:${p.revision}] ${p.summary}\nAuthors: ${p.authors.join(",")}; applicability: ${JSON.stringify(p.applicability)}; exceptions: ${JSON.stringify(p.exceptions)}; source IDs: ${p.sourceIds.join(",")}`;
    if (selected.length === 12 || used + Buffer.byteLength(line) > 23500)
      continue;
    selected.push(p);
    text.push(line);
    used += Buffer.byteLength(line) + 1;
  }
  if (!selected.length) return;
  const ids = new Set(selected.flatMap((p) => p.sourceIds));
  const scope = memoryScope(w, r);
  if (!scope) return;
  return {
    entryIds: [],
    preferences: selected.map((p) => ({
      id: p.preferenceId,
      revision: p.revision,
    })),
    text: `${text.join("\n")}\n${eligible.length - selected.length} relevant preferences omitted by context bounds.`,
    ...memoryReferences(
      scopeSources(w, scope, Date.now(), r.actor).filter((s) => ids.has(s.id)),
    ),
  };
}

export function preferenceContextValid(
  w: Workspace,
  context: MemoryContext,
  actor?: string,
) {
  return (context.preferences ?? []).every(
    (ref) =>
      (ref.referenceOnly || preferenceSettings(w).recall !== "off") &&
      w.memory?.preferences?.some(
        (p) =>
          p.preferenceId === ref.id &&
          p.revision === ref.revision &&
          (ref.referenceOnly
            ? p.status !== "superseded"
            : p.status === "active_reference") &&
          scopeActive(w, p.scope) &&
          (!actor || p.scope.kind !== "private" || p.scope.actor === actor) &&
          (!actor ||
            !p.applicability.repositoryId ||
            verifiedRepositoryAccess(
              w,
              actor,
              p.applicability.repositoryId,
              false,
            )) &&
          validMemory(p, scopeSources(w, p.scope, Date.now(), actor)),
      ),
  );
}

export function recordDecisionCase(
  w: Workspace,
  source: Source,
  taskId: string,
  input: {
    revision: number;
    kind: "request" | "answer" | "followup";
    questionId?: string;
  } = { revision: 1, kind: "request" },
) {
  if (!preferenceSettings(w).derive) return;
  const run = w.runs.find((r) => r.id === source.runId);
  const scope = run && memoryScope(w, run);
  if (
    !scope ||
    source.role !== "user" ||
    source.author !== run?.actor ||
    !scopeActive(w, scope) ||
    !scopeSources(w, scope).some((s) => s.id === source.id)
  )
    return;
  const state = memoryState(w);
  const id = `case:${hashMemory([w.id, source.id, source.text]).slice(0, 32)}`;
  if (
    state.cases?.some((c) => c.id === id) ||
    state.entries.length +
      (state.cases?.length ?? 0) +
      (state.preferences?.length ?? 0) >=
      256
  )
    return;
  state.cases = [
    ...(state.cases ?? []),
    {
      id,
      taskId,
      inputRevision: input.revision,
      inputKind: input.kind,
      questionId: input.questionId,
      evidence: "authored_input",
      expiresAt: source.expiresAt,
      scope,
      threadId: source.threadId as string,
      title: `Decision in task ${taskId}`,
      summary: redactMemory(source.text).slice(0, 4000),
      authors: [source.author],
      updatedAt: new Date().toISOString(),
      usageCount: 0,
      ...memoryReferences([source]),
    },
  ];
}

export const preferenceCandidates = z
  .array(
    z
      .object({
        statement: z.string().min(1).max(2000),
        sourceIds: z.array(z.string()).min(1).max(20),
      })
      .strict(),
  )
  .max(4);
export function derivePreferenceCandidates(
  w: Workspace,
  run: Run,
  proposals: z.infer<typeof preferenceCandidates>,
  supplied: Source[],
) {
  if (!preferenceSettings(w).derive) return;
  const scope = memoryScope(w, run);
  if (!scope || !scopeActive(w, scope)) return;
  const state = memoryState(w);
  for (const proposal of proposals) {
    const ids = new Set(proposal.sourceIds);
    const evidence = supplied.filter((s) => ids.has(s.id) && s.role === "user");
    requireThat(
      evidence.length === ids.size &&
        evidence.every((s) =>
          scopeSources(w, scope).some((valid) => valid.id === s.id),
        ),
      "memory_evidence_invalid",
      409,
    );
    if (redactMemory(proposal.statement) !== proposal.statement) continue;
    const preferenceId = `pref:${hashMemory([w.id, scopeKey(scope), [...ids].sort(), proposal.statement]).slice(0, 32)}`;
    if (state.preferences?.some((p) => p.preferenceId === preferenceId))
      continue;
    if (
      state.entries.length +
        (state.cases?.length ?? 0) +
        (state.preferences?.length ?? 0) >=
      256
    )
      break;
    state.preferences = [
      ...(state.preferences ?? []),
      {
        id: `${preferenceId}:1`,
        preferenceId,
        revision: 1,
        status: "candidate",
        evidence: evidence.length > 1 ? "repeated" : "single_observation",
        scope,
        threadId: run.threadId as string,
        title: "Inferred preference candidate",
        summary: proposal.statement,
        authors: [...new Set(evidence.map((s) => s.author))],
        updatedAt: new Date().toISOString(),
        usageCount: 0,
        applicability: { taskId: run.codingTaskId ?? run.id },
        exceptions: [],
        ...memoryReferences(evidence),
      },
    ];
  }
}
