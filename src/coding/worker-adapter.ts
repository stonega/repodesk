import type { LocalRunner } from "./local/protocol.ts";

export type CodingWorkerKind = "codex" | "claude_code" | "gemini_cli";

export interface CodingWorkerCapabilities {
  kind: CodingWorkerKind;
  label: string;
  available: boolean;
  supportsInvestigation: boolean;
  supportsRelease: boolean;
  supportsResume: boolean;
}

/**
 * Pluggable worker seam decoupling orchestration and repository queues from
 * a specific coding CLI harness. Initially implemented by Codex LocalRunner.
 */
export interface CodingWorkerAdapter {
  readonly kind: CodingWorkerKind;
  readonly label: string;
  capabilities(): CodingWorkerCapabilities;
  runner(): LocalRunner | undefined;
}

export class CodexLocalWorkerAdapter implements CodingWorkerAdapter {
  readonly kind = "codex" as const;
  readonly label = "Codex CLI Runner";
  constructor(private local?: LocalRunner) {}

  capabilities(): CodingWorkerCapabilities {
    return {
      kind: this.kind,
      label: this.label,
      available: !!this.local,
      supportsInvestigation: true,
      supportsRelease: true,
      supportsResume: true,
    };
  }

  runner(): LocalRunner | undefined {
    return this.local;
  }
}

export class CodingWorkerRegistry {
  private adapters = new Map<CodingWorkerKind, CodingWorkerAdapter>();

  constructor(initial: CodingWorkerAdapter[] = []) {
    for (const adapter of initial) {
      this.adapters.set(adapter.kind, adapter);
    }
  }

  register(adapter: CodingWorkerAdapter): void {
    this.adapters.set(adapter.kind, adapter);
  }

  get(kind: CodingWorkerKind): CodingWorkerAdapter | undefined {
    return this.adapters.get(kind);
  }

  list(): CodingWorkerCapabilities[] {
    return [...this.adapters.values()].map((a) => a.capabilities());
  }

  resolve(
    preferred: CodingWorkerKind = "codex",
  ): CodingWorkerAdapter | undefined {
    const chosen = this.adapters.get(preferred);
    if (chosen?.capabilities().available) return chosen;
    for (const adapter of this.adapters.values()) {
      if (adapter.capabilities().available) return adapter;
    }
    return chosen;
  }
}
