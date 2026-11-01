import { randomUUID } from "node:crypto";
import { requireThat } from "../domain.ts";
import { fingerprint } from "../setup/credentials.ts";
import type { BrowserAccessRequest, BrowserAccessState } from "./access.ts";
import {
  type BrowserController,
  type BrowserOwner,
  browserController,
  browserLimits,
  browserOwner,
} from "./config.ts";

export interface BrowserLease {
  controller: BrowserController;
  generation: number;
  expiresAt: number;
}
export interface BrowserInputRequest {
  callId?: string;
  id: string;
  controller: BrowserController;
  generation: number;
  origin: string;
  pageId: string;
  pageRevision: number;
  selector: string;
  label: string;
  kind: "password" | "code" | "text";
  expiresAt: number;
  state:
    | "waiting"
    | "applying"
    | "completed"
    | "cancelled"
    | "expired"
    | "unknown";
  submissionId?: string;
}
export interface BrowserOperation {
  id: string;
  hash: string;
  generation: number;
  state: "started" | "completed";
  // Only safe status/references; private browser content stays in the host service.
  result?: { status: string; reference?: string };
}
export interface BrowserState extends BrowserOwner {
  receipts?: {
    id: string;
    controller: BrowserController;
    callId: string;
    at: number;
    result: NonNullable<BrowserAccessRequest["result"]>;
  }[];
  epoch?: number;
  lifecycle?: "closed" | "deleted";
  access?: BrowserAccessState;
  cleanup?: { command: "close" | "delete"; generation: number };
  revision: number;
  generation: number;
  lease?: BrowserLease;
  input?: BrowserInputRequest;
  operations: BrowserOperation[];
}

export function profileKey(owner: BrowserOwner) {
  return fingerprint(browserOwner.parse(owner));
}
export function emptyBrowserState(owner: BrowserOwner): BrowserState {
  return {
    ...browserOwner.parse(owner),
    revision: 0,
    generation: 0,
    operations: [],
  };
}
export function sameController(a: BrowserController, b: BrowserController) {
  return (
    fingerprint(browserController.parse(a)) ===
    fingerprint(browserController.parse(b))
  );
}
function invalidateInput(state: BrowserState, now: number) {
  if (!state.input || !["waiting", "applying"].includes(state.input.state))
    return;
  state.input.state =
    state.input.state === "applying"
      ? "unknown"
      : state.input.expiresAt <= now
        ? "expired"
        : "cancelled";
}

/** The caller must already be authorized; this function never grants identity. */
export function acquireBrowser(
  state: BrowserState,
  value: BrowserController,
  now = Date.now(),
  takeover = false,
) {
  const controller = browserController.parse(value);
  requireThat(
    !takeover || controller.kind === "human",
    "browser_takeover_denied",
    403,
  );
  const active = state.lease && state.lease.expiresAt > now;
  const same =
    state.lease && sameController(state.lease.controller, controller);
  const resumed =
    state.lease &&
    state.lease.controller.kind === controller.kind &&
    state.lease.controller.id === controller.id &&
    state.lease.controller.pluginId === controller.pluginId &&
    state.lease.controller.pluginRevision === controller.pluginRevision &&
    controller.fence > state.lease.controller.fence;
  if (active && !same) requireThat(takeover || resumed, "browser_busy", 409);
  if (!active || !same) {
    invalidateInput(state, now);
    state.generation++;
  }
  state.lease = {
    controller,
    generation: state.generation,
    expiresAt: Math.max(
      now + browserLimits.leaseMs,
      same && state.input?.state === "waiting" ? state.input.expiresAt : 0,
    ),
  };
  state.revision++;
  return structuredClone(state.lease);
}
export function requireBrowserLease(
  state: BrowserState,
  controller: BrowserController,
  generation: number,
  now = Date.now(),
) {
  requireThat(
    state.lease &&
      state.lease.expiresAt > now &&
      state.generation === generation &&
      state.lease.generation === generation &&
      sameController(state.lease.controller, controller),
    "browser_control_expired",
    409,
  );
}
export function releaseBrowser(state: BrowserState, now = Date.now()) {
  invalidateInput(state, now);
  state.generation++;
  state.lease = undefined;
  state.revision++;
}
export function reserveBrowserOperation(
  state: BrowserState,
  controller: BrowserController,
  generation: number,
  id: string,
  args: unknown,
  now = Date.now(),
) {
  requireBrowserLease(state, controller, generation, now);
  const hash = fingerprint(args);
  const previous = state.operations.find((operation) => operation.id === id);
  if (previous) {
    requireThat(
      previous.hash === hash && previous.generation === generation,
      "browser_duplicate_conflict",
      409,
    );
    requireThat(previous.state === "completed", "browser_outcome_unknown", 409);
    return structuredClone(previous);
  }
  requireThat(
    !state.input || !["waiting", "applying"].includes(state.input.state),
    "browser_input_pending",
    409,
  );
  // Never evict an uncertain receipt and accidentally allow its action to replay.
  state.operations = state.operations.filter(
    (operation) =>
      operation.state === "started" || operation.generation === generation,
  );
  requireThat(state.operations.length < 512, "browser_capacity", 409);
  state.operations.push({ id, hash, generation, state: "started" });
  state.revision++;
}
export function requestBrowserInput(
  state: BrowserState,
  controller: BrowserController,
  generation: number,
  input: Pick<
    BrowserInputRequest,
    "origin" | "pageId" | "pageRevision" | "selector" | "label" | "kind"
  >,
  now = Date.now(),
) {
  requireBrowserLease(state, controller, generation, now);
  requireThat(
    !state.input || !["waiting", "applying"].includes(state.input.state),
    "browser_input_pending",
    409,
  );
  const url = new URL(input.origin);
  requireThat(
    url.origin === input.origin && ["https:", "http:"].includes(url.protocol),
    "browser_destination_denied",
    403,
  );
  state.input = {
    ...input,
    id: randomUUID(),
    controller,
    generation,
    expiresAt: now + browserLimits.requestMs,
    state: "waiting",
  };
  // Input waits outlive an ordinary operation lease without granting another caller control.
  if (state.lease) state.lease.expiresAt = state.input.expiresAt;
  state.revision++;
  return structuredClone(state.input);
}
export function reserveBrowserInput(
  state: BrowserState,
  requestId: string,
  submissionId: string,
  now = Date.now(),
) {
  const input = state.input;
  requireThat(input?.id === requestId, "browser_input_unavailable", 404);
  requireThat(input.expiresAt > now, "browser_input_expired", 410);
  requireBrowserLease(state, input.controller, input.generation, now);
  if (input.submissionId) {
    requireThat(
      input.submissionId === submissionId,
      "browser_duplicate_conflict",
      409,
    );
    requireThat(input.state === "completed", "browser_outcome_unknown", 409);
    return { completed: true as const, input: structuredClone(input) };
  }
  requireThat(input.state === "waiting", "browser_input_unavailable", 409);
  input.state = "applying";
  input.submissionId = submissionId;
  state.revision++;
  return { completed: false as const, input: structuredClone(input) };
}
