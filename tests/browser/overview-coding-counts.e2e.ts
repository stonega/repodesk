import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { hash } from "../../src/setup/credentials.ts";
import { developmentTask, teamWorkspace } from "../team-workflows-fixture.ts";

for (const width of [1280, 390]) {
  test(`Overview coding count opens the matching task list at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = JSON.parse(
      await readFile(join(tmpdir(), "repodesk-browser-3107-db.json"), "utf8"),
    );
    const pool = database(fixture.url);
    const store = new Store(pool);
    const operatorId = randomUUID();
    const raw = randomUUID();
    const w = teamWorkspace();
    w.operatorId = operatorId;
    const direct = developmentTask(w);
    direct.payload.title = "Direct task waiting for an answer";
    const completed = developmentTask(w);
    completed.payload.title = "Direct task ready for review";
    completed.state = "review";
    completed.question = undefined;
    const reviewed = {
      id: randomUUID(),
      actor: direct.actor,
      runId: randomUUID(),
      chatId: direct.chatId,
      topicId: direct.topicId,
      payload: { ...direct.payload, title: "Completed Reviewed task" },
      state: "succeeded" as const,
      createdAt: direct.createdAt,
      updatedAt: direct.updatedAt,
    };
    // Retained tasks remain visible without an active GitHub connection.
    w.github = undefined;
    try {
      await pool.query(
        "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,$2,'unused',true)",
        [operatorId, `counts-${operatorId}`],
      );
      await pool.query(
        "INSERT INTO sessions(token_hash,admin_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
        [hash(raw), operatorId, randomUUID()],
      );
      await pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, operatorId, JSON.stringify(w)],
      );
      await page.context().addCookies([
        {
          name: "repodesk_session",
          value: raw,
          url: "http://127.0.0.1:3107",
        },
      ]);
      await page.route("**/api/setup/status", (route) =>
        route.fulfill({ json: { initialized: true } }),
      );
      const overviewUrl = `/admin/overview?workspace=${w.id}`;
      const counts = page.getByRole("region", { name: "Workspace counts" });
      await page.goto(overviewUrl);
      await expect(
        counts.getByRole("link", { name: "0 coding tasks. View details" }),
      ).toBeVisible();
      for (const task of [direct, completed])
        await pool.query(
          "INSERT INTO coding_tasks(workspace_id,id,data) VALUES($1,$2,$3)",
          [w.id, task.id, JSON.stringify(task)],
        );
      await page.reload();
      await expect(
        counts.getByRole("link", { name: "2 coding tasks. View details" }),
      ).toBeVisible();
      await store.change(w.id, (saved) => {
        saved.codingTasks = [reviewed];
      });
      await page.reload();
      const card = counts.getByRole("link", {
        name: "3 coding tasks. View details",
      });
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute(
        "href",
        `/admin/plugins/codex?workspace=${w.id}#coding-tasks`,
      );
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
      await page.screenshot({
        path: test.info().outputPath("overview-coding-count.png"),
        fullPage: true,
      });
      await card.click();
      await expect(page).toHaveURL(
        new RegExp(`/admin/plugins/codex\\?workspace=${w.id}#coding-tasks$`),
      );
      const tasks = page.getByRole("region", { name: "Coding tasks" });
      for (const task of [direct, completed, reviewed])
        await expect(
          tasks.getByRole("row").filter({ hasText: task.payload.title }),
        ).toBeVisible();
      await expect(tasks.getByRole("row")).toHaveCount(4);
      await page.screenshot({
        path: test.info().outputPath("coding-tasks.png"),
        fullPage: true,
      });
    } finally {
      await page.goto("about:blank");
      await pool.query("DELETE FROM coding_tasks WHERE workspace_id=$1", [
        w.id,
      ]);
      await pool.query("DELETE FROM workspaces WHERE id=$1", [w.id]);
      await pool.query("DELETE FROM sessions WHERE admin_id=$1", [operatorId]);
      await pool.query("DELETE FROM admins WHERE id=$1", [operatorId]);
      await pool.end();
    }
  });
}
