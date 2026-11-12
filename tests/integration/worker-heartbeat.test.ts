import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.ts";
import { migrate, migrateJobs } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { startWorker } from "../../src/jobs/queue.ts";
import { SetupService } from "../../src/setup/service.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "Worker readiness during slow maintenance",
  () => {
    const root = database(url ?? "postgres://unused@localhost/unused");
    const name = `heartbeat_${randomUUID().replaceAll("-", "")}`;
    let store: Store;
    let target: string;
    beforeAll(async () => {
      await root.query(`CREATE DATABASE ${name}`);
      const parsed = new URL(url ?? "");
      parsed.pathname = `/${name}`;
      target = parsed.toString();
      store = new Store(database(target));
      await migrate(store.pool);
      await migrateJobs(target);
    }, 30000);
    afterAll(async () => {
      await store?.pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    });
    test("a slow maintenance pass does not age out a live worker, and shutdown removes its heartbeat", async () => {
      const setup = new SetupService(
        store,
        "ab".repeat(32),
        "http://localhost:3000",
      );
      const blocked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let slow = false;
      const activation = spyOn(setup, "autoActivate").mockImplementation(
        async () => {
          if (slow) {
            blocked.resolve();
            await release.promise;
          }
          return false;
        },
      );
      const ticks: (() => void)[] = [];
      const interval = globalThis.setInterval;
      const captureIntervals = ((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) => {
        if (delay === 5000) ticks.push(() => callback(...args));
        return interval(callback, delay, ...args);
      }) as typeof globalThis.setInterval;
      const timers = spyOn(globalThis, "setInterval").mockImplementation(
        captureIntervals,
      );
      let stop: (() => Promise<void>) | undefined;
      try {
        stop = await startWorker(store, setup, target);
        timers.mockRestore();
        slow = true;
        for (const tick of ticks) tick();
        await blocked.promise;
        await store.pool.query(
          "UPDATE worker_heartbeats SET at=now()-interval '40 seconds'",
        );
        for (const tick of ticks) tick();
        let fresh = false;
        for (let attempt = 0; attempt < 50; attempt++) {
          fresh = !!(
            await store.pool.query(
              "SELECT 1 FROM worker_heartbeats WHERE at>now()-interval '2 seconds'",
            )
          ).rowCount;
          if (fresh) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(fresh).toBe(true);
        expect(
          (
            await createApp(store, setup, "http://localhost:3000").request(
              "/readyz",
            )
          ).status,
        ).toBe(200);
      } finally {
        timers.mockRestore();
        activation.mockRestore();
        release.resolve();
        await stop?.();
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        (await store.pool.query("SELECT 1 FROM worker_heartbeats")).rowCount,
      ).toBe(0);
      expect(
        (
          await createApp(store, setup, "http://localhost:3000").request(
            "/readyz",
          )
        ).status,
      ).toBe(503);
    }, 15000);
  },
);
