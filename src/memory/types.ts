import type { MemoryReferences } from "../domain.ts";

export interface MemoryScope {
  kind: "private" | "group";
  botId: string;
  chatId: string;
  actor?: string;
  topicId?: number;
}
export interface MemoryEntry extends MemoryReferences {
  id: string;
  scope: MemoryScope;
  threadId: string;
  title: string;
  summary: string;
  authors: string[];
  updatedAt: string;
  usageCount: number;
  lastUsedAt?: string;
  explicit?: boolean;
}
export interface MemoryContext extends MemoryReferences {
  entryIds: string[];
  text: string;
  preferences?: { id: string; revision: number; referenceOnly?: boolean }[];
}
export interface PreferenceEntry extends MemoryEntry {
  createdAt?: string;
  previousRevision?: number;
  correctionActor?: string;
  correctionSourceId?: string;
  preferenceId: string;
  revision: number;
  status: "candidate" | "active_reference" | "superseded" | "disputed";
  evidence: "explicit" | "repeated" | "single_observation";
  applicability: { repositoryId?: number; domain?: string; taskId?: string };
  exceptions: string[];
}
export interface DecisionCase extends MemoryEntry {
  taskId: string;
  inputRevision: number;
  inputKind: "request" | "answer" | "followup";
  evidence: "authored_input";
  questionId?: string;
  expiresAt: string;
}
export interface MemoryJob extends MemoryReferences {
  id: string;
  scope: MemoryScope;
  threadId: string;
  runId: string;
  phase: "extract" | "consolidate";
  status: "running" | "retry" | "done" | "failed";
  token: string;
  leaseUntil: string;
  retryAt?: string;
  tries: number;
  transcript: unknown[];
  attemptIds: string[];
  inputHash?: string;
  inputSourceIds?: string[];
  entryIds?: string[];
  error?: string;
  at: string;
}
export interface MemoryState {
  preferenceReceipts?: {
    sourceId: string;
    preferenceId: string;
    revision: number;
  }[];
  preferences?: PreferenceEntry[];
  cases?: DecisionCase[];
  preferenceSettings?: {
    derive: boolean;
    recall: "off" | "pi" | "pi_and_coding";
  };
  entries: MemoryEntry[];
  jobs: MemoryJob[];
  checkpoints: { threadId: string; sourceHash: string; at: string }[];
  indexes: {
    scope: MemoryScope;
    inputHash: string;
    entryIds: string[];
    text: string;
  }[];
  forgotten: { scope: MemoryScope; sourceIds: string[] }[];
  disabled: string[];
}
