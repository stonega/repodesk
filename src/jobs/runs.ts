import type { PgBoss } from "pg-boss";
import type { Store } from "../db/repositories.ts";
import type { Executor } from "./execute.ts";
import type { JobData } from "./queue.ts";

/** Queue jobs wake durable runs; execution belongs to the fenced application lease. */
export class RunWorker {
  private active = new Map<string, Promise<void>>();
  private polling?: Promise<void>;
  constructor(
    private store: Store,
    private boss: PgBoss,
    private executor: Executor,
    private signal: AbortSignal,
  ) {}

  poll(): Promise<void> {
    this.polling ??= this.fetch().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  private async fetch() {
    const available = 3 - this.active.size;
    if (this.signal.aborted || available <= 0) return;
    const jobs = await this.boss.fetch<JobData>("run", {
      batchSize: available,
    });
    for (const job of jobs) {
      // A crash after acknowledgement is recovered from the durable outbox/run.
      // Never keep a queue job active for the lifetime of an assistant request:
      // pg-boss requires a finite expiry even when the application has no deadline.
      const completed = await this.boss.complete("run", job.id);
      if (
        !("affected" in completed) ||
        completed.affected !== 1 ||
        this.signal.aborted
      )
        continue;
      const { workspaceId, targetId: runId } = job.data;
      const key = `${workspaceId}:${runId}`;
      if (this.active.has(key)) continue;
      const work = this.executor
        .execute(workspaceId, runId, this.signal)
        .catch((error) => {
          this.store.log.write("run_failed", { error, workspaceId, runId });
        })
        .finally(() => {
          this.active.delete(key);
        });
      this.active.set(key, work);
    }
  }

  async drain() {
    await this.polling?.catch(() => {});
    await Promise.all(this.active.values());
  }
}
