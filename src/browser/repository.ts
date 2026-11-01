import type { Pool } from "pg";
import { z } from "zod";
import { transaction } from "../db/pool.ts";
import { requireThat } from "../domain.ts";
import { decrypt, encrypt } from "../setup/credentials.ts";
import { browserAccessRequest, browserAccessState } from "./access.ts";
import {
  type BrowserOwner,
  browserController,
  browserOwner,
} from "./config.ts";
import { type BrowserState, emptyBrowserState, profileKey } from "./state.ts";

const safeInteger = z.number().int().nonnegative().safe();
const stateSchema = browserOwner
  .extend({
    receipts: z
      .array(
        z
          .object({
            id: z.uuid(),
            controller: browserController,
            callId: z.string().min(1).max(200),
            at: safeInteger,
            result: browserAccessRequest.shape.result.unwrap(),
          })
          .strict(),
      )
      .max(256)
      .optional(),
    epoch: safeInteger.optional(),
    lifecycle: z.enum(["closed", "deleted"]).optional(),
    access: browserAccessState.optional(),
    cleanup: z
      .object({ command: z.enum(["close", "delete"]), generation: safeInteger })
      .strict()
      .optional(),
    revision: safeInteger,
    generation: safeInteger,
    lease: z
      .object({
        controller: browserController,
        generation: safeInteger,
        expiresAt: safeInteger,
      })
      .strict()
      .optional(),
    input: z
      .object({
        callId: z.string().min(1).max(200).optional(),
        id: z.uuid(),
        controller: browserController,
        generation: safeInteger,
        origin: z.string().max(2048),
        pageId: z.string().min(1).max(100),
        pageRevision: safeInteger,
        selector: z.string().min(1).max(500),
        label: z.string().min(1).max(100),
        kind: z.enum(["password", "code", "text"]),
        expiresAt: safeInteger,
        state: z.enum([
          "waiting",
          "applying",
          "completed",
          "cancelled",
          "expired",
          "unknown",
        ]),
        submissionId: z.uuid().optional(),
      })
      .strict()
      .optional(),
    operations: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
            generation: safeInteger,
            state: z.enum(["started", "completed"]),
            result: z
              .object({
                status: z.string().max(100),
                reference: z.string().max(200).optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(512),
  })
  .strict();

export interface BrowserRepository {
  read(owner: BrowserOwner): Promise<BrowserState>;
  change<T>(
    owner: BrowserOwner,
    action: (state: BrowserState) => T,
  ): Promise<T>;
}

/** AAD binds ciphertext to the full verified owner; rows cannot be swapped. */
export class PostgresBrowserRepository implements BrowserRepository {
  constructor(
    private pool: Pool,
    private key: string,
  ) {}
  async owners(workspaceId: string): Promise<BrowserOwner[]> {
    return (
      await this.pool.query(
        "SELECT workspace_id,actor FROM browser_profiles WHERE workspace_id=$1 ORDER BY actor",
        [workspaceId],
      )
    ).rows.map((row) =>
      browserOwner.parse({ workspaceId: row.workspace_id, actor: row.actor }),
    );
  }
  private decode(owner: BrowserOwner, value?: string): BrowserState {
    if (!value) return emptyBrowserState(owner);
    const state = stateSchema.parse(
      JSON.parse(decrypt(this.key, `browser:${profileKey(owner)}`, value)),
    );
    requireThat(
      state.workspaceId === owner.workspaceId && state.actor === owner.actor,
      "access_denied",
      403,
    );
    return state;
  }
  async read(value: BrowserOwner) {
    const owner = browserOwner.parse(value);
    const row = (
      await this.pool.query(
        "SELECT data FROM browser_profiles WHERE workspace_id=$1 AND actor=$2",
        [owner.workspaceId, owner.actor],
      )
    ).rows[0];
    return this.decode(owner, row?.data);
  }
  async change<T>(value: BrowserOwner, action: (state: BrowserState) => T) {
    const owner = browserOwner.parse(value);
    return transaction(this.pool, async (sql) => {
      const name = `browser:${profileKey(owner)}`;
      await sql.query(
        "INSERT INTO browser_profiles(workspace_id,actor,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [
          owner.workspaceId,
          owner.actor,
          encrypt(this.key, name, JSON.stringify(emptyBrowserState(owner))),
        ],
      );
      const row = (
        await sql.query(
          "SELECT data FROM browser_profiles WHERE workspace_id=$1 AND actor=$2 FOR UPDATE",
          [owner.workspaceId, owner.actor],
        )
      ).rows[0];
      const state = this.decode(owner, row?.data);
      const before = JSON.stringify(state),
        revision = state.revision;
      const result = action(state);
      stateSchema.parse(state);
      requireThat(
        state.workspaceId === owner.workspaceId && state.actor === owner.actor,
        "access_denied",
        403,
      );
      if (JSON.stringify(state) === before) return result;
      if (state.revision === revision) state.revision++;
      await sql.query(
        "UPDATE browser_profiles SET data=$3,updated_at=now() WHERE workspace_id=$1 AND actor=$2",
        [
          owner.workspaceId,
          owner.actor,
          encrypt(this.key, name, JSON.stringify(state)),
        ],
      );
      return result;
    });
  }
}
