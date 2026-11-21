import { z } from "zod";
import type { AutonomyMode } from "../autonomy/policy.ts";

export const DEFAULT_MAX_MISSION_WAKEUPS = 8;
export const DEFAULT_MAX_AUTO_TIMERS = 3;
export const MIN_AUTO_TIMER_MINUTES = 1;
export const MAX_AUTO_TIMER_MINUTES = 72 * 60; // 72 hours

export const missionStatusSchema = z.enum([
  "active",
  "waiting",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "halted",
]);
export type MissionStatus = z.infer<typeof missionStatusSchema>;

export const missionWaitKindSchema = z.enum([
  "coding_task",
  "approval",
  "browser",
  "timer",
  "research",
  "github_event",
]);
export type MissionWaitKind = z.infer<typeof missionWaitKindSchema>;

export const missionWaitStatusSchema = z.enum([
  "pending",
  "satisfied",
  "failed",
  "cancelled",
  "expired",
]);
export type MissionWaitStatus = z.infer<typeof missionWaitStatusSchema>;

export const missionJoinModeSchema = z.enum(["all", "any"]);
export type MissionJoinMode = z.infer<typeof missionJoinModeSchema>;

export interface MissionArtifact {
  id: string;
  kind:
    | "summary"
    | "pr"
    | "commit"
    | "issue"
    | "obsidian_note"
    | "research"
    | "reference"
    | "other";
  label: string;
  value: string;
  repositoryId?: number;
  repository?: string;
  provenance?: string;
  at: string;
}

export interface Mission {
  id: string;
  workspaceId: string;
  actor: string;
  chatId: string;
  topicId: number;
  threadId?: string;
  botId?: string;
  status: MissionStatus;
  goal: string;
  originSourceIds: string[];
  autonomyMode: AutonomyMode;
  autonomyRevision: number;
  wakeupCount: number;
  maxWakeups: number;
  autoTimerCount: number;
  maxAutoTimers: number;
  fence: number;
  groupRepositoryVersion?: number;
  lastRunId?: string;
  lastTimerStateHash?: string;
  consecutiveUnchangedTimers?: number;
  spentUsd: number;
  summary?: string;
  error?: string;
  artifacts: MissionArtifact[];
  childTaskIds: string[];
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface MissionWait {
  id: string;
  workspaceId: string;
  missionId: string;
  joinGroup: string;
  joinMode: MissionJoinMode;
  kind: MissionWaitKind;
  targetId: string;
  status: MissionWaitStatus;
  reason?: string;
  dueAt?: string;
  result?: Record<string, unknown>;
  createdAt: string;
  resolvedAt?: string;
}

export interface MissionDetail {
  mission: Mission;
  waits: MissionWait[];
}

export function missionTerminal(status: MissionStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "halted"
  );
}
