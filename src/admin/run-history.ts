import type { Delivery, Run, Workspace } from "../domain.ts";

export interface RunSummary
  extends Pick<Run, "id" | "actor" | "status" | "at" | "model"> {
  taskPreview: string;
  attemptCount: number;
  deliveryStates: Delivery["state"][];
}

export interface RunHistoryPage {
  mode: "member" | "operator";
  items: RunSummary[];
  total: number;
  offset: number;
  limit: number;
}

export function runSummaries(w: Workspace, offset: number, limit: number) {
  const end = Math.max(0, w.runs.length - offset);
  const runs = w.runs.slice(Math.max(0, end - limit), end).reverse();
  const states = new Map(
    runs.map((run) => [run.id, new Set<Delivery["state"]>()]),
  );
  for (const delivery of w.deliveries) {
    if (delivery.runId) states.get(delivery.runId)?.add(delivery.state);
    if (delivery.cancellationRunId)
      states.get(delivery.cancellationRunId)?.add(delivery.state);
  }
  return runs.map((run): RunSummary => {
    const task = run.task.replace(/\s+/g, " ").trim();
    return {
      id: run.id,
      actor: run.actor,
      status: run.status,
      at: run.at,
      model: run.model,
      taskPreview: task.length > 200 ? `${task.slice(0, 199)}…` : task,
      attemptCount: run.attempts.length,
      deliveryStates: [...(states.get(run.id) ?? [])],
    };
  });
}
