import { operator } from "../admin/auth.ts";
import type { PluginRecord } from "../agent/plugin-config.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, requireThat, type Workspace } from "../domain.ts";
import { audit } from "../workspaces/policy.ts";
import {
  audioLimits,
  qwenModel,
  type TranscriptionPage,
  transcriptionSave,
} from "./config.ts";
import { qwenRuntime, type TranscriptionRuntime } from "./runtime.ts";

function authorize(admin: Admin, workspace: Workspace) {
  operator(admin);
  requireThat(
    workspace.operatorId === admin.id && !workspace.deletion,
    "access_denied",
    403,
  );
}
export class TranscriptionService {
  constructor(
    private store: Store,
    private runtime: TranscriptionRuntime = qwenRuntime,
  ) {}
  async view(admin: Admin, workspaceId: string): Promise<TranscriptionPage> {
    const w = await this.store.read(workspaceId);
    authorize(admin, w);
    return {
      revision: w.plugins?.revision ?? 0,
      settings: w.plugins?.transcription ?? { enabled: false, generation: 0 },
      model: qwenModel,
      status: await this.runtime.status(),
      limits: audioLimits,
    };
  }
  async configure(
    admin: Admin,
    workspaceId: string,
    value: unknown,
    entries: PluginRecord[],
  ) {
    const input = transcriptionSave.parse(value);
    await this.store.change(workspaceId, (w) => {
      authorize(admin, w);
      requireThat(
        (w.plugins?.revision ?? 0) === input.revision,
        "version_conflict",
        409,
      );
      w.plugins = {
        ...w.plugins,
        entries,
        revision: input.revision + 1,
        transcription: {
          enabled: input.enabled,
          generation: (w.plugins?.transcription?.generation ?? 0) + 1,
        },
      };
      audit(
        w,
        admin.id,
        "plugins.updated",
        "transcription",
        w.plugins.revision,
      );
    });
    if (input.enabled) this.runtime.prepare();
    return this.view(admin, workspaceId);
  }
  async retry(admin: Admin, workspaceId: string, value: unknown) {
    const input = transcriptionSave.parse(value);
    const w = await this.store.read(workspaceId);
    authorize(admin, w);
    requireThat(
      input.enabled && w.plugins?.transcription?.enabled,
      "audio_plugin_disabled",
      409,
    );
    requireThat(
      (w.plugins?.revision ?? 0) === input.revision,
      "version_conflict",
      409,
    );
    this.runtime.prepare();
    return this.view(admin, workspaceId);
  }
  /** Reconcile durable enablement after a restart without blocking maintenance on a download. */
  async reconcile(w: Workspace) {
    if (
      !w.deletion &&
      w.plugins?.transcription?.enabled &&
      (await this.runtime.status()).state === "not_downloaded"
    )
      this.runtime.prepare();
  }
  async transcribe(
    workspaceId: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const w = await this.store.read(workspaceId);
    const setting = w.plugins?.transcription;
    requireThat(setting?.enabled && !w.deletion, "audio_plugin_disabled", 409);
    const text = await this.runtime.transcribe(bytes, signal);
    signal.throwIfAborted();
    const current = await this.store.read(workspaceId);
    requireThat(
      !current.deletion &&
        current.plugins?.transcription?.enabled &&
        current.plugins.transcription.generation === setting.generation,
      "run_revoked",
      409,
    );
    return text;
  }
}
