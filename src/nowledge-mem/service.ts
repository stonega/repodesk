import { z } from "zod";
import { operator } from "../admin/auth.ts";
import type { PluginRecord } from "../agent/plugin-config.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, Fault, requireThat, type Workspace } from "../domain.ts";
import { decrypt, encrypt, hash } from "../setup/credentials.ts";
import {
  audit,
  eligible,
  revokeWork,
  runAllowed,
} from "../workspaces/policy.ts";
import { NowledgeClient, remoteMemory } from "./client.ts";
import {
  emptyNowledge,
  type NowledgePage,
  nowledgeQuery,
  nowledgeSave,
  nowledgeTools,
  nowledgeUrl,
  nowledgeWrite,
} from "./config.ts";

function authority(admin: Admin, w: Workspace) {
  operator(admin);
  requireThat(w.operatorId === admin.id && !w.deletion, "access_denied", 403);
}
function scope(
  w: Workspace,
  runId: string,
  actor: string,
  fence: number,
  revision: number,
) {
  const run = w.runs.find((r) => r.id === runId);
  requireThat(
    run &&
      run.actor === actor &&
      run.status === "running" &&
      run.fence === fence &&
      runAllowed(w, run),
    "run_revoked",
    403,
  );
  requireThat(
    run.chatId === actor && !run.workflowId,
    "nowledge_mem_private_request_required",
    403,
  );
  requireThat(
    w.plugins?.revision === revision,
    "extension_configuration_changed",
    409,
  );
  const config = w.plugins.nowledgeMem;
  requireThat(
    config?.settings.enabled && config.credential && config.botId,
    "nowledge_mem_not_configured",
    409,
  );
  requireThat(
    config.settings.memberId === actor && eligible(w, actor),
    "access_denied",
    403,
  );
  return { run, config };
}
// This is an exact-content command, not model-authored consent or transcript capture.
export function authoredMemory(text: string) {
  const match =
    /^\s*(?:(?:please\s+)?(?:save|remember|store)\s+(?:this\s+)?(?:to|in)\s+nowledge(?:\s+mem)?\s*[:：]|(?:請|请)?(?:幫我|帮我)?(?:儲存|保存|存入|存到|記住|记住)(?:到|在)?\s*nowledge(?:\s+mem)?\s*[:：])\s*([\s\S]+)$/i.exec(
      text,
    );
  const content = match?.[1]?.trim();
  requireThat(
    content && content.length <= 16000,
    "nowledge_mem_explicit_save_required",
    403,
  );
  return content;
}
export class NowledgeService {
  private client: NowledgeClient;
  constructor(
    private store: Store,
    private key = "",
    transport?: typeof fetch,
  ) {
    this.client = new NowledgeClient(transport);
  }
  async executionFence(id: string, runId: string) {
    const run = (await this.store.read(id)).runs.find((r) => r.id === runId);
    requireThat(run, "run_revoked", 403);
    return run.fence;
  }
  async view(admin: Admin, id: string): Promise<NowledgePage> {
    const w = await this.store.read(id);
    authority(admin, w);
    return {
      revision: w.plugins?.revision ?? 0,
      settings: w.plugins?.nowledgeMem?.settings ?? emptyNowledge,
      credentialConfigured: !!w.plugins?.nowledgeMem?.credential,
      members: w.members
        .filter((m) => m.active)
        .map((m) => ({ id: m.id, name: m.name ?? m.username ?? m.id })),
    };
  }
  private credential(w: Workspace, apiUrl: string, key?: string) {
    requireThat(this.key, "nowledge_mem_credentials_unavailable", 503);
    if (key) return key;
    const config = w.plugins?.nowledgeMem;
    requireThat(
      config?.credential && config.settings.apiUrl === apiUrl,
      "nowledge_mem_not_configured",
      409,
    );
    try {
      return decrypt(this.key, `nowledge-mem:${w.id}`, config.credential);
    } catch {
      throw new Fault("nowledge_mem_credentials_unavailable", 503);
    }
  }
  async spaces(admin: Admin, id: string, value: unknown) {
    const w = await this.store.read(id);
    authority(admin, w);
    const input = z
      .object({ apiUrl: nowledgeUrl, apiKey: nowledgeSave.shape.apiKey })
      .strict()
      .parse(value);
    const result = await this.client.spaces(
      input.apiUrl,
      this.credential(w, input.apiUrl, input.apiKey),
    );
    authority(admin, await this.store.read(id));
    return result;
  }
  async configure(
    admin: Admin,
    id: string,
    value: unknown,
    entries?: PluginRecord[],
  ) {
    const input = nowledgeSave.parse(value);
    const deployment = await this.store.deployment();
    await this.store.change(id, (w) => {
      authority(admin, w);
      requireThat(
        (w.plugins?.revision ?? 0) === input.revision,
        "version_conflict",
        409,
      );
      const prior = w.plugins?.nowledgeMem;
      const changedDestination =
        !!prior &&
        (prior.settings.apiUrl !== input.settings.apiUrl ||
          prior.settings.memberId !== input.settings.memberId);
      let credential =
        changedDestination || input.removeCredential
          ? undefined
          : prior?.credential;
      if (input.apiKey) {
        requireThat(this.key, "nowledge_mem_credentials_unavailable", 503);
        credential = encrypt(this.key, `nowledge-mem:${id}`, input.apiKey);
      }
      requireThat(
        !input.settings.enabled || eligible(w, input.settings.memberId),
        "access_denied",
        403,
      );
      requireThat(
        !input.settings.enabled ||
          (credential &&
            input.settings.apiUrl &&
            input.settings.memberId &&
            input.settings.spaceId &&
            deployment.bot?.id),
        "nowledge_mem_not_configured",
        409,
      );
      requireThat(
        !input.settings.enabled ||
          !(w.plugins?.entries ?? entries ?? []).some(
            (e) =>
              e.enabled &&
              e.tools.some((name) =>
                (nowledgeTools as readonly string[]).includes(name),
              ),
          ),
        "extension_tool_collision",
        409,
      );
      w.plugins = {
        ...w.plugins,
        revision: input.revision + 1,
        entries: w.plugins?.entries ?? entries ?? [],
        nowledgeMem: {
          settings: input.settings,
          credential,
          botId: deployment.bot?.id,
        },
      };
      revokeWork(w);
      audit(w, admin.id, "plugins.updated", "nowledge-mem", w.plugins.revision);
    });
    return this.view(admin, id);
  }
  async tool(
    id: string,
    runId: string,
    actor: string,
    fence: number,
    revision: number,
    action: "query" | "save",
    value: unknown,
    signal?: AbortSignal,
    guard = async () => {},
  ) {
    const check = async () => {
      signal?.throwIfAborted();
      await guard();
      const w = await this.store.read(id);
      const current = scope(w, runId, actor, fence, revision);
      const d = await this.store.deployment();
      requireThat(
        d.active && !d.paused && d.bot?.id === current.config.botId,
        "deployment_paused",
        409,
      );
      return { w, ...current };
    };
    const initial = await check();
    const config = initial.config;
    const space = config.settings.spaceId;
    const apiKey = this.credential(initial.w, config.settings.apiUrl);
    const mark = async () =>
      this.store.change(id, (w) => {
        const { run } = scope(w, runId, actor, fence, revision);
        run.nowledgeRead = { revision, botId: config.botId as string };
      });
    if (action === "save") {
      const input = nowledgeWrite.parse(value);
      const source = initial.w.messages.find(
        (s) =>
          s.id === input.sourceId &&
          s.runId === runId &&
          s.role === "user" &&
          !s.forwarded &&
          s.author === actor &&
          s.chatId === actor &&
          s.topicId === initial.run.topicId &&
          s.threadId === initial.run.threadId &&
          initial.run.sources.some((known) => known.id === s.id),
      );
      requireThat(
        source &&
          authoredMemory(initial.run.task) === authoredMemory(source.text),
        "nowledge_mem_explicit_save_required",
        403,
      );
      const content = authoredMemory(source.text);
      const memoryId = `repodesk-${hash(JSON.stringify([id, actor, source.id]))}`;
      const prior = initial.run.nowledgeSaves?.[source.id];
      if (prior) {
        requireThat(
          prior.state === "saved",
          "nowledge_mem_save_uncertain",
          409,
        );
        return { id: prior.id, status: "saved" };
      }
      await this.store.change(id, (w) => {
        const { run } = scope(w, runId, actor, fence, revision);
        requireThat(
          !run.nowledgeSaves?.[source.id],
          "nowledge_mem_save_uncertain",
          409,
        );
        run.nowledgeRead = { revision, botId: config.botId as string };
        run.nowledgeSaves ??= {};
        run.nowledgeSaves[source.id] = {
          id: memoryId,
          state: "started",
        };
      });
      await check();
      const result = z.object({ memory: remoteMemory }).safeParse(
        await this.client.request(
          config.settings.apiUrl,
          apiKey,
          "/memories",
          {
            id: memoryId,
            content,
            space_id: space,
            source: "repodesk",
            source_app: "repodesk",
          },
          signal,
        ),
      );
      requireThat(
        result.success &&
          result.data.memory.id === memoryId &&
          result.data.memory.space_id === space,
        "nowledge_mem_invalid_response",
        502,
      );
      await check();
      await this.store.change(id, (w) => {
        const { run } = scope(w, runId, actor, fence, revision);
        const receipt = run.nowledgeSaves?.[source.id];
        requireThat(
          receipt?.id === memoryId,
          "nowledge_mem_save_uncertain",
          409,
        );
        receipt.state = "saved";
      });
      return { id: memoryId, status: "saved" };
    }
    const input = nowledgeQuery.parse(value);
    await mark();
    await check();
    const encodedSpace = encodeURIComponent(space);
    const result = input.query
      ? await this.client.request(
          config.settings.apiUrl,
          apiKey,
          "/memories/search",
          {
            query: input.query,
            limit: input.limit,
            space_id: space,
            include_entities: false,
            mode: "fast",
          },
          signal,
        )
      : await this.client.request(
          config.settings.apiUrl,
          apiKey,
          input.id
            ? `/memories/${encodeURIComponent(input.id)}?space_id=${encodedSpace}`
            : `/memories?space_id=${encodedSpace}&limit=${input.limit}`,
          undefined,
          signal,
        );
    const schema = input.id
      ? remoteMemory.transform((m) => [m])
      : input.query
        ? z
            .array(z.object({ memory: remoteMemory }))
            .max(input.limit)
            .transform((rows) => rows.map((r) => r.memory))
        : z
            .object({ memories: z.array(remoteMemory).max(input.limit) })
            .transform((r) => r.memories);
    const parsed = schema.safeParse(result);
    requireThat(
      parsed.success &&
        parsed.data.every(
          (m) => m.space_id === space && (!input.id || m.id === input.id),
        ),
      "nowledge_mem_invalid_response",
      502,
    );
    await check();
    return {
      spaceId: space,
      referenceOnly: true,
      memories: parsed.data.map((m) => ({
        id: m.id,
        title: m.title ?? "",
        content: m.content.slice(0, input.id ? 16000 : 1200),
        truncated: m.content.length > (input.id ? 16000 : 1200),
      })),
    };
  }
}
