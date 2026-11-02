import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import type { AgentInput, AgentRunner } from "../../src/agent/runtime.ts";
import { migrate, migrateJobs } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { Executor } from "../../src/jobs/execute.ts";
import { dispatch, queue } from "../../src/jobs/queue.ts";
import { recoverJobs } from "../../src/jobs/recovery.ts";
import { RunWorker } from "../../src/jobs/runs.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { cancelRun, createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "Durable assistant dispatch without a deadline",
  () => {
    const root = database(url ?? "postgres://unused@localhost/unused");
    const name = `repodesk_runs_${randomUUID().replaceAll("-", "")}`;
    const operator = randomUUID();
    const key = "ab".repeat(32);
    let store: Store;
    let setup: SetupService;
    let boss: PgBoss;

    beforeAll(async () => {
      await root.query(`CREATE DATABASE ${name}`);
      const target = new URL(url ?? "");
      target.pathname = `/${name}`;
      store = new Store(database(target.toString()));
      await migrate(store.pool);
      await migrateJobs(target.toString());
      boss = queue(target.toString());
      await boss.start();
      await store.pool.query(
        "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,'operator','unused',true)",
        [operator],
      );
      const deployment = await store.deployment();
      deployment.active = true;
      deployment.credentials.model = encrypt(key, "model", "test-key");
      await store.saveDeployment(store.pool, deployment);
      setup = new SetupService(store, key, "http://localhost:3000");
    }, 30000);

    beforeEach(async () => {
      await boss.deleteAllJobs("run");
      await store.pool.query("DELETE FROM outbox");
      await store.pool.query("DELETE FROM workspaces");
    });

    afterAll(async () => {
      await boss?.stop();
      await store?.pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    });

    async function seed() {
      const w = workspace();
      w.operatorId = operator;
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, operator, JSON.stringify(w)],
      );
      const run = await store.change(w.id, (current) =>
        createRun(
          current,
          "101",
          "Read the repository",
          "-100100",
          0,
          "gpt-4.1-mini",
        ),
      );
      return { w, run };
    }

    const result = () => ({
      text: "Repository checked.",
      status: "succeeded" as const,
      turns: 1,
      tools: 0,
      transcript: [],
    });

    test("long analysis survives the old deadline and duplicate dispatch while its lease is live", async () => {
      const { w, run } = await seed();
      const started = Promise.withResolvers<AgentInput>();
      const release = Promise.withResolvers<void>();
      const oldDeadline = new AbortController();
      const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(
        oldDeadline.signal,
      );
      let calls = 0;
      const runner: AgentRunner = {
        async run(input) {
          calls++;
          started.resolve(input);
          await release.promise;
          await input.guard();
          return result();
        },
      };
      const worker = new RunWorker(
        store,
        boss,
        new Executor(store, setup, runner),
        new AbortController().signal,
      );
      let clock: ReturnType<typeof spyOn<typeof Date, "now">> | undefined;
      try {
        await dispatch(store, boss);
        const [job] = await boss.findJobs("run", {});
        expect(job).toBeDefined();
        await worker.poll();
        const input = await started.promise;
        expect((await boss.getJobById("run", job?.id ?? ""))?.state).toBe(
          "completed",
        );
        // Model the former total deadline firing and 31 minutes of elapsed analysis.
        oldDeadline.abort(new DOMException("old deadline", "TimeoutError"));
        clock = spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60000);
        await input.guard();
        expect(input.signal.aborted).toBe(false);
        await boss.send("run", { workspaceId: w.id, targetId: run.id });
        await worker.poll();
        await recoverJobs(store, boss);
        expect(await dispatch(store, boss)).toBe(0);
        expect(calls).toBe(1);
        expect((await store.read(w.id)).runs[0]?.status).toBe("running");
        expect(timeout).not.toHaveBeenCalledWith(300000);
      } finally {
        clock?.mockRestore();
        timeout.mockRestore();
        release.resolve();
        await worker.drain();
      }
      const saved = await store.read(w.id);
      expect(saved.runs[0]?.status).toBe("succeeded");
      expect(saved.runs[0]?.result).toBe("Repository checked.");
      expect(saved.deliveries.filter((d) => d.runId === run.id)).toHaveLength(
        1,
      );
    });

    test("a crash between queue acknowledgement and run claim is recovered once", async () => {
      const { w, run } = await seed();
      await dispatch(store, boss);
      const [job] = await boss.fetch("run");
      expect(job).toBeDefined();
      await boss.complete("run", job?.id ?? "");
      await recoverJobs(store, boss);
      expect(await dispatch(store, boss)).toBe(1);
      let calls = 0;
      const worker = new RunWorker(
        store,
        boss,
        new Executor(store, setup, {
          async run() {
            calls++;
            return result();
          },
        }),
        new AbortController().signal,
      );
      await worker.poll();
      await worker.drain();
      const jobs = await boss.findJobs("run", {});
      await recoverJobs(store, boss);
      await dispatch(store, boss);
      expect(await boss.findJobs("run", {})).toHaveLength(jobs.length);
      expect(calls).toBe(1);
      expect(
        (await store.read(w.id)).runs.find((r) => r.id === run.id)?.status,
      ).toBe("succeeded");
    });

    test("recovery stops an expired run with uncertain provider usage before redispatch", async () => {
      const { w, run } = await seed();
      await dispatch(store, boss);
      const [job] = await boss.fetch("run");
      await boss.complete("run", job?.id ?? "");
      await store.change(w.id, (current) => {
        const r = current.runs[0];
        if (!r) throw Error("Missing run");
        r.status = "running";
        r.fence = 1;
        r.leaseUntil = new Date(0).toISOString();
        r.attempts.push({
          id: randomUUID(),
          at: r.at,
          reserved: 0.001,
          status: "reserved",
        });
      });
      await recoverJobs(store, boss);
      await dispatch(store, boss);
      let calls = 0;
      const worker = new RunWorker(
        store,
        boss,
        new Executor(store, setup, {
          async run() {
            calls++;
            return result();
          },
        }),
        new AbortController().signal,
      );
      await worker.poll();
      await worker.drain();
      const saved = (await store.read(w.id)).runs.find((r) => r.id === run.id);
      expect(calls).toBe(0);
      expect(saved?.error).toBe("provider_outcome_unknown");
      expect(saved?.attempts[0]?.status).toBe("unknown");
      expect(saved?.attempts[0]?.reserved).toBe(0.001);
    });

    test("concurrency stays bounded while queued work remains durable", async () => {
      const items = await Promise.all(Array.from({ length: 4 }, () => seed()));
      const release = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      let calls = 0;
      const worker = new RunWorker(
        store,
        boss,
        new Executor(store, setup, {
          async run() {
            calls++;
            if (calls === 3) started.resolve();
            await release.promise;
            return result();
          },
        }),
        new AbortController().signal,
      );
      try {
        await dispatch(store, boss);
        await Promise.all([worker.poll(), worker.poll()]);
        await started.promise;
        await worker.poll();
        expect(calls).toBe(3);
        expect(
          (await boss.findJobs("run", {})).filter((j) => j.state === "created"),
        ).toHaveLength(1);
      } finally {
        release.resolve();
        await worker.drain();
      }
      await worker.poll();
      await worker.drain();
      expect(calls).toBe(4);
      for (const { w } of items)
        expect((await store.read(w.id)).runs[0]?.status).toBe("succeeded");
    });

    for (const cause of ["user", "revoked", "shutdown"] as const) {
      test(`long executions still stop on ${cause}`, async () => {
        const { w, run } = await seed();
        const shutdown = new AbortController();
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const worker = new RunWorker(
          store,
          boss,
          new Executor(store, setup, {
            async run(input) {
              await input.reserve(0.001);
              started.resolve();
              await release.promise;
              await input.guard();
              return result();
            },
          }),
          shutdown.signal,
        );
        try {
          await dispatch(store, boss);
          await worker.poll();
          await started.promise;
          if (cause === "shutdown") shutdown.abort();
          else
            await store.change(w.id, (current) => {
              if (cause === "user") cancelRun(current, "101", run.id);
              else
                current.members.forEach((m) => {
                  m.active = false;
                });
            });
        } finally {
          release.resolve();
          await worker.drain();
        }
        const saved = (await store.read(w.id)).runs[0];
        expect(saved?.status).toBe(
          cause === "revoked" ? "failed" : "cancelled",
        );
        expect(saved?.error).toBe(
          cause === "shutdown"
            ? "worker_shutdown"
            : cause === "user"
              ? "cancelled"
              : "run_revoked",
        );
        expect(saved?.result).toBeUndefined();
        expect(saved?.attempts[0]?.status).toBe("unknown");
        expect(saved?.attempts[0]?.reserved).toBe(0.001);
      });
    }
  },
);
