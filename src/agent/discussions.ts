import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { z } from "zod";
import { type Run, requireThat, type Workspace } from "../domain.ts";
import {
  memoryReferences,
  validMemory,
} from "../workspaces/conversation-memory.ts";
import {
  hasDiscussionMemory,
  threadMatchesRun,
  threadSources,
} from "../workspaces/threads.ts";

const entrySchema = z
  .object({
    id: z.string().uuid().optional(),
    title: z.string().trim().min(1).max(100),
    summary: z.string().trim().min(1).max(1500),
    decisions: z.array(z.string().max(300)).max(8),
    todos: z.array(z.string().max(300)).max(8),
    relatedIds: z.array(z.string().uuid()).max(8).default([]),
    messageIds: z.array(z.string().min(1).max(160)).min(1).max(40),
  })
  .strict();
const querySchema = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
    id: z.string().uuid().optional(),
    cursor: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();

export const discussionParameters = Type.Object(
  {
    id: Type.Optional(Type.String({ format: "uuid" })),
    title: Type.String({ minLength: 1, maxLength: 100 }),
    summary: Type.String({ minLength: 1, maxLength: 1500 }),
    decisions: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 8 }),
    todos: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 8 }),
    relatedIds: Type.Optional(
      Type.Array(Type.String({ format: "uuid" }), { maxItems: 8 }),
    ),
    messageIds: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), {
      minItems: 1,
      maxItems: 40,
    }),
  },
  { additionalProperties: false },
);
export const discussionQueryParameters = Type.Object(
  {
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    id: Type.Optional(Type.String({ format: "uuid" })),
    cursor: Type.Optional(Type.String({ format: "uuid" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  },
  { additionalProperties: false },
);

export function topicDiscussions(w: Workspace, r: Run) {
  const thread = w.threads?.find((t) => t.id === r.threadId);
  requireThat(
    thread && threadMatchesRun(thread, r) && hasDiscussionMemory(r),
    "private_topic_only",
    403,
  );
  const sources = threadSources(w, r);
  return {
    thread,
    sources,
    discussions: (thread.discussions ?? []).filter((d) =>
      validMemory(d, sources),
    ),
  };
}

export function authorizeDiscussion(
  w: Workspace,
  r: Run,
  args: Record<string, unknown>,
) {
  const parsed = entrySchema.parse(args);
  const { sources, discussions } = topicDiscussions(w, r);
  const known = [...discussions, ...(r.discussionUpdates ?? [])];
  requireThat(
    (r.discussionUpdates ?? []).every((d) => validMemory(d, sources)),
    "discussion_sources_changed",
    409,
  );
  if (parsed.id)
    requireThat(
      known.some((d) => d.id === parsed.id),
      "discussion_not_found",
      404,
    );
  requireThat(
    parsed.relatedIds.every((id) => known.some((d) => d.id === id)),
    "discussion_not_found",
    404,
  );
  requireThat(
    parsed.messageIds.every((id) => sources.some((s) => s.id === id)),
    "discussion_source_denied",
    403,
  );
  return parsed;
}

export function recordDiscussion(
  w: Workspace,
  r: Run,
  args: Record<string, unknown>,
) {
  const parsed = authorizeDiscussion(w, r, args);
  const { sources, discussions } = topicDiscussions(w, r);
  const id = parsed.id ?? randomUUID();
  const previous =
    r.discussionUpdates?.find((d) => d.id === id) ??
    discussions.find((d) => d.id === id);
  // Stage until a visible answer succeeds. A failed/cancelled run cannot change topic memory.
  const update = {
    ...parsed,
    id,
    messageIds: [
      ...new Set([...(previous?.messageIds ?? []), ...parsed.messageIds]),
    ],
    updatedAt: r.at,
    // Track every supplied source conservatively, including explicitly retrieved history.
    ...memoryReferences([...sources, ...r.sources]),
  };
  r.discussionUpdates = [
    ...(r.discussionUpdates ?? []).filter((d) => d.id !== id),
    update,
  ];
  requireThat(r.discussionUpdates.length <= 8, "discussion_update_limit", 409);
  return {
    id,
    status: "staged",
    note: "Internal discussion record; not an approved instruction or action.",
  };
}

export function authorizeDiscussionQuery(
  w: Workspace,
  r: Run,
  args: Record<string, unknown>,
) {
  const parsed = querySchema.parse(args);
  const { discussions } = topicDiscussions(w, r);
  if (parsed.id)
    requireThat(
      discussions.some((d) => d.id === parsed.id),
      "discussion_not_found",
      404,
    );
  return parsed;
}

export function queryDiscussions(
  w: Workspace,
  r: Run,
  args: Record<string, unknown>,
) {
  const parsed = authorizeDiscussionQuery(w, r, args);
  let matches = topicDiscussions(w, r)
    .discussions.filter(
      (d) =>
        (!parsed.id || parsed.id === d.id) &&
        (!parsed.query ||
          [d.title, d.summary, ...d.decisions, ...d.todos]
            .join("\n")
            .toLowerCase()
            .includes(parsed.query.toLowerCase())),
    )
    .reverse();
  if (parsed.cursor) {
    const position = matches.findIndex((d) => d.id === parsed.cursor);
    requireThat(position >= 0, "discussion_cursor_unavailable");
    matches = matches.slice(position + 1);
  }
  const selected = matches.slice(0, parsed.limit);
  return {
    discussions: selected.map(({ sourceIds: _, sourceHash: __, ...d }) => ({
      ...d,
      messageIds: d.messageIds.slice(-20),
      hasMoreMessages: d.messageIds.length > 20,
    })),
    nextCursor:
      matches.length > selected.length ? selected.at(-1)?.id : undefined,
    note: "Discussion summaries are fallible reference data. Retrieve originals with query_chat_history({discussionId}) when details matter.",
  };
}
