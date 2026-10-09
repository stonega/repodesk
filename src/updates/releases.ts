import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { operator } from "../admin/auth.ts";
import { transaction } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, Fault, requireThat } from "../domain.ts";

export const installedVersion: string = JSON.parse(
  readFileSync("package.json", "utf8"),
).version;
export type ReleaseTransport = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
const stableTag = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function newerRelease(tag: string, current: string) {
  const next = stableTag.exec(tag);
  const previous = stableTag.exec(current);
  if (!next || !previous) return false;
  for (let i = 1; i <= 3; i++) {
    const a = BigInt(next[i] ?? "0"),
      b = BigInt(previous[i] ?? "0");
    if (a !== b) return a > b;
  }
  return false;
}
const releaseSchema = z.object({
  id: z.number().int().positive().safe(),
  tag_name: z.string().regex(stableTag),
  name: z.string().max(500).nullable(),
  body: z.string().max(125000).nullable(),
  published_at: z.iso.datetime(),
  draft: z.literal(false),
  prerelease: z.literal(false),
});
export interface Release {
  id: number;
  tag: string;
  name: string;
  notes: string;
  publishedAt: string;
  url: string;
  commit: string;
  fingerprint: string;
}
export interface UpdateAttempt {
  state: "queued" | "running" | "succeeded" | "failed" | "unknown";
  error?: string;
}
export interface UpdateView {
  currentVersion: string;
  repository: string;
  available: boolean;
  configured: boolean;
  updaterReady?: boolean;
  checkedAt?: string;
  error?: string;
  release?: Release;
  attempt?: UpdateAttempt;
}
export const updateInput = z
  .object({
    releaseId: z.number().int().positive().safe(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    retry: z.boolean().optional(),
  })
  .strict();

/** The API queues approved updates; only the separately installed host agent cuts over. */
export class ReleaseUpdates {
  private cached?: { at: number; release?: Release; error?: string };
  private checking?: Promise<void>;
  constructor(
    private store: Store,
    private repository = "stonega/repodesk",
    private token?: string,
    private currentVersion = installedVersion,
    private transport: ReleaseTransport = fetch,
    private now = Date.now,
    private directory?: string,
  ) {}
  private async request(path: string) {
    try {
      return await this.transport(
        `https://api.github.com/repos/${this.repository}${path}`,
        {
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: {
            accept: "application/vnd.github+json",
            "content-type": "application/json",
            "user-agent": "RepoDesk-updates",
            "x-github-api-version": "2026-03-10",
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          },
        },
      );
    } catch {
      throw new Fault("release_check_unavailable", 503);
    }
  }
  private async refresh(force = false) {
    if (this.checking) return this.checking;
    const ttl = this.cached?.error ? 60000 : 15 * 60000;
    if (!force && this.cached && this.now() - this.cached.at < ttl) return;
    this.checking = (async () => {
      try {
        const response = await this.request("/releases/latest");
        if (response.status === 404) {
          this.cached = { at: this.now() };
          return;
        }
        requireThat(response.ok, "release_check_unavailable", 503);
        const raw = releaseSchema.parse(await response.json());
        const commitResponse = await this.request(
          `/commits/${encodeURIComponent(raw.tag_name)}`,
        );
        requireThat(commitResponse.ok, "release_check_unavailable", 503);
        const { sha } = z
          .object({ sha: z.string().regex(/^[a-f0-9]{40}$/) })
          .parse(await commitResponse.json());
        const release = {
          id: raw.id,
          tag: raw.tag_name,
          name: raw.name || raw.tag_name,
          notes: raw.body ?? "",
          publishedAt: raw.published_at,
          commit: sha,
          url: `https://github.com/${this.repository}/releases/tag/${encodeURIComponent(raw.tag_name)}`,
          fingerprint: createHash("sha256")
            .update(JSON.stringify([raw, sha]))
            .digest("hex"),
        };
        this.cached = { at: this.now(), release };
      } catch {
        this.cached = {
          at: this.now(),
          release: this.cached?.release,
          error: "Could not check GitHub releases. Try again shortly.",
        };
      }
    })().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }
  async view(admin: Admin): Promise<UpdateView> {
    await this.refresh();
    const release = this.cached?.release;
    return {
      currentVersion: this.currentVersion,
      repository: this.repository,
      configured: admin.operator && !!this.directory,
      updaterReady: admin.operator && (await this.ready()),
      available: !!release && newerRelease(release.tag, this.currentVersion),
      checkedAt: this.cached
        ? new Date(this.cached.at).toISOString()
        : undefined,
      error: this.cached?.error,
      release,
      attempt:
        admin.operator && release ? await this.attempt(release.id) : undefined,
    };
  }
  private async ready() {
    if (!this.directory) return false;
    try {
      const heartbeat = JSON.parse(
        await readFile(join(this.directory, "heartbeat.json"), "utf8"),
      );
      return (
        heartbeat.repository === this.repository &&
        Math.abs(this.now() - Date.parse(heartbeat.at)) < 30000
      );
    } catch {
      return false;
    }
  }
  private async attempt(releaseId: number): Promise<UpdateAttempt | undefined> {
    const row = (
      await this.store.pool.query(
        "SELECT state,request_id,fingerprint,release_id FROM deployment_updates WHERE repository=$1 AND (release_id=$2 OR state IN ('dispatching','queued','running','unknown')) ORDER BY (state IN ('dispatching','queued','running','unknown')) DESC, requested_at DESC LIMIT 1",
        [this.repository, releaseId],
      )
    ).rows[0];
    if (!row) return;
    let state: UpdateAttempt["state"] =
      row.state === "dispatching" ? "unknown" : row.state;
    let error: string | undefined;
    if (this.directory) {
      try {
        const result = z
          .object({
            requestId: z.literal(row.request_id),
            fingerprint: z.literal(row.fingerprint),
            state: z.enum([
              "queued",
              "running",
              "succeeded",
              "failed",
              "unknown",
            ]),
            error: z
              .enum([
                "update_failed",
                "update_interrupted",
                "release_changed",
                "verification_failed",
              ])
              .optional(),
          })
          .parse(
            JSON.parse(
              await readFile(
                join(this.directory, "results", `${row.request_id}.json`),
                "utf8",
              ),
            ),
          );
        state = result.state;
        error = result.error;
        if (state === "running" && !(await this.ready())) {
          state = "unknown";
          error = "update_interrupted";
        }
      } catch {
        if (["dispatching", "unknown"].includes(row.state)) {
          try {
            await access(
              join(this.directory, "requests", `${row.request_id}.json`),
            );
            state = "queued";
          } catch {
            /* Uncertain queue publication stays fenced. */
          }
        }
        if (state === "running" && !(await this.ready())) {
          state = "unknown";
          error = "update_interrupted";
        }
      }
      await this.store.pool.query(
        "UPDATE deployment_updates SET state=$3 WHERE repository=$1 AND release_id=$2 AND request_id=$4",
        [this.repository, row.release_id, state, row.request_id],
      );
    }
    return { state, error };
  }
  async start(admin: Admin, value: unknown): Promise<UpdateView> {
    operator(admin);
    requireThat(this.directory, "updates_not_configured", 409);
    const input = updateInput.parse(value);
    await this.refresh(true);
    requireThat(!this.cached?.error, "release_check_unavailable", 503);
    const release = this.cached?.release;
    requireThat(
      release &&
        release.id === input.releaseId &&
        release.fingerprint === input.fingerprint,
      "release_changed",
      409,
    );
    requireThat(
      newerRelease(release.tag, this.currentVersion),
      "update_not_available",
      409,
    );
    // Reconcile previous host results before reserving a new attempt.
    await this.attempt(release.id);
    requireThat(await this.ready(), "updater_unavailable", 409);
    const requestId = randomUUID();
    const reserved = await transaction(this.store.pool, async (sql) => {
      await sql.query("SELECT pg_advisory_xact_lock(701932582)");
      const existing = (
        await sql.query(
          "SELECT state,release_id FROM deployment_updates WHERE repository=$1 AND (release_id=$2 OR state IN ('dispatching','queued','running','unknown')) ORDER BY (state IN ('dispatching','queued','running','unknown')) DESC LIMIT 1",
          [this.repository, release.id],
        )
      ).rows[0];
      if (
        existing &&
        !(
          existing.state === "failed" &&
          Number(existing.release_id) === release.id &&
          input.retry
        )
      )
        return false;
      await sql.query(
        "INSERT INTO deployment_updates(repository,release_id,actor,fingerprint,state,request_id) VALUES($1,$2,$3,$4,'dispatching',$5) ON CONFLICT(repository,release_id) DO UPDATE SET actor=$3,fingerprint=$4,state='dispatching',request_id=$5,requested_at=now()",
        [this.repository, release.id, admin.id, release.fingerprint, requestId],
      );
      await sql.query(
        "INSERT INTO operator_audit(actor,action,target) VALUES($1,'deployment.update_requested',$2)",
        [admin.id, `${this.repository}@${release.tag}`],
      );
      return true;
    });
    if (!reserved) return this.view(admin);
    try {
      await mkdir(join(this.directory, "requests"), { recursive: true });
      // Publish once, only after the authorization and durable reservation commit.
      const file = await open(
        join(this.directory, "requests", `${requestId}.pending`),
        "wx",
        0o600,
      );
      try {
        await file.writeFile(
          JSON.stringify({
            requestId,
            repository: this.repository,
            releaseId: release.id,
            fingerprint: release.fingerprint,
            tag: release.tag,
            commit: release.commit,
          }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(
        join(this.directory, "requests", `${requestId}.pending`),
        join(this.directory, "requests", `${requestId}.json`),
      );
      const directory = await open(join(this.directory, "requests"), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      await this.store.pool.query(
        "UPDATE deployment_updates SET state='queued' WHERE repository=$1 AND release_id=$2 AND request_id=$3 AND state='dispatching'",
        [this.repository, release.id, requestId],
      );
    } catch {
      await this.store.pool.query(
        "UPDATE deployment_updates SET state='unknown' WHERE repository=$1 AND release_id=$2 AND request_id=$3 AND state='dispatching'",
        [this.repository, release.id, requestId],
      );
      throw new Fault("update_queue_unknown", 503);
    }
    return this.view(admin);
  }
}
