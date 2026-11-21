export interface SkillAutoMetadata {
  sourceKind: "conversation" | "coding_task" | "mission";
  sourceId: string;
  extractedAt: string;
  updatedAt: string;
  rationale?: string;
  confidence?: "high" | "medium";
  revisions: number;
}

export interface SkillUsageStats {
  loads: number;
  lastLoadedAt?: string;
  codingInjections?: number;
  lastInjectedAt?: string;
}

export interface SkillSuppression {
  slug: string;
  name: string;
  scopeKey: string;
  reason: "archived" | "disabled";
  at: string;
}

export interface SkillExtractionJob {
  id: string;
  sourceKind: "conversation" | "coding_task" | "mission";
  sourceId: string;
  checkpointKey: string;
  inputHash: string;
  runId?: string;
  actor: string;
  repositoryId?: number;
  repository?: string;
  status: "running" | "retry" | "done" | "failed";
  token: string;
  leaseUntil: string;
  retryAt?: string;
  tries: number;
  attemptIds: string[];
  error?: string;
  at: string;
}

export interface SkillExtractionState {
  enabled?: boolean;
  jobs: SkillExtractionJob[];
  checkpoints: { key: string; hash: string; at: string }[];
  suppressed: SkillSuppression[];
}
