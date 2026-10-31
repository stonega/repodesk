import { randomUUID } from "node:crypto";
import { requireThat } from "../domain.ts";
import type { BrowserAccessRequest } from "./access.ts";
import type { BrowserHost } from "./client.ts";
import {
  type BrowserController,
  type BrowserOwner,
  browserAction,
} from "./config.ts";
import type { BrowserHostPolicy, HostResult } from "./protocol.ts";
import type { BrowserRepository } from "./repository.ts";
import {
  acquireBrowser,
  releaseBrowser,
  requestBrowserInput,
  requireBrowserLease,
  reserveBrowserInput,
  reserveBrowserOperation,
  sameController,
} from "./state.ts";

// Constructed by trusted application adapters after binding the actual actor.
// It is not a model-facing request schema or a caller-supplied authorization flag.
export interface BrowserAuthority {
  owner: BrowserOwner;
  controller: BrowserController;
  guard: () => Promise<void>;
  signal?: AbortSignal;
  policy?: (controller: BrowserController) => Promise<BrowserHostPolicy>;
}

export class BrowserControl {
  constructor(
    private repository: BrowserRepository,
    private host: BrowserHost,
  ) {}
  private async check(authority: BrowserAuthority) {
    authority.signal?.throwIfAborted();
    await authority.guard();
    authority.signal?.throwIfAborted();
  }
  async acquire(authority: BrowserAuthority, takeover = false) {
    await this.check(authority);
    const lease = await this.repository.change(authority.owner, (state) => {
      const lease = acquireBrowser(
        state,
        authority.controller,
        Date.now(),
        takeover,
      );
      delete state.lifecycle;
      return lease;
    });
    await this.check(authority);
    await this.host.invoke(
      {
        owner: authority.owner,
        controller: authority.controller,
        generation: lease.generation,
        operation: { command: "acquire" },
        policy: await authority.policy?.(authority.controller),
      },
      authority.signal,
    );
    await this.check(authority);
    await this.repository.change(authority.owner, (state) =>
      requireBrowserLease(state, authority.controller, lease.generation),
    );
    return lease;
  }
  async perform(
    authority: BrowserAuthority,
    generation: number,
    operationId: string,
    value: unknown,
    page?: BrowserAccessRequest["page"],
  ): Promise<HostResult> {
    const input = browserAction.parse(value);
    await this.check(authority);
    const previous = await this.repository.change(authority.owner, (state) =>
      reserveBrowserOperation(
        state,
        authority.controller,
        generation,
        operationId,
        page ? { input, page } : input,
      ),
    );
    if (previous?.result)
      return { status: "completed", reference: previous.result.reference };
    // Persist started before dispatch. Failure or cancellation deliberately leaves
    // an uncertain receipt, so neither a retry nor a restart repeats the effect.
    await this.check(authority);
    const result = await this.host.invoke(
      {
        owner: authority.owner,
        controller: authority.controller,
        generation,
        operation: { command: "action", input, ...(page ? { page } : {}) },
        policy: await authority.policy?.(authority.controller),
      },
      authority.signal,
    );
    await this.check(authority);
    await this.repository.change(authority.owner, (state) => {
      requireBrowserLease(state, authority.controller, generation);
      const operation = state.operations.find((op) => op.id === operationId);
      requireThat(
        operation?.state === "started",
        "browser_outcome_unknown",
        409,
      );
      if (input.action === "request_input") {
        requireThat(result.page, "browser_page_changed", 409);
        requestBrowserInput(state, authority.controller, generation, {
          selector: input.selector,
          label: input.label,
          kind: input.kind,
          origin: result.page.origin,
          pageId: result.page.id,
          pageRevision: result.page.revision,
        });
      }
      operation.state = "completed";
      operation.result = { status: result.status, reference: result.reference };
      state.revision++;
    });
    return result;
  }
  async submitInput(
    authority: BrowserAuthority,
    requestId: string,
    submissionId: string,
    value: string,
  ) {
    requireThat(
      value.length > 0 && value.length <= 4096,
      "browser_input_invalid",
      400,
    );
    await this.check(authority);
    const reservation = await this.repository.change(authority.owner, (state) =>
      reserveBrowserInput(state, requestId, submissionId),
    );
    if (reservation.completed) return { status: "completed" as const };
    const input = reservation.input;
    await this.check(authority);
    // The input's original controller, page revision and origin remain bound.
    // Neither the user form nor a plugin can change the credential destination.
    await this.host.invoke(
      {
        owner: authority.owner,
        controller: input.controller,
        generation: input.generation,
        operation: {
          command: "input",
          requestId,
          pageId: input.pageId,
          pageRevision: input.pageRevision,
          origin: input.origin,
          selector: input.selector,
          value,
        },
        policy: await authority.policy?.(input.controller),
      },
      authority.signal,
    );
    await this.check(authority);
    await this.repository.change(authority.owner, (state) => {
      requireBrowserLease(state, input.controller, input.generation);
      requireThat(
        state.input?.id === requestId &&
          state.input.state === "applying" &&
          state.input.submissionId === submissionId,
        "browser_outcome_unknown",
        409,
      );
      state.input.state = "completed";
      if (state.lease) state.lease.expiresAt = Date.now() + 120_000;
      state.revision++;
    });
    return { status: "completed" as const };
  }
  async release(authority: BrowserAuthority) {
    await this.check(authority);
    const generation = await this.repository.change(
      authority.owner,
      (state) => {
        if (state.lease)
          requireBrowserLease(state, authority.controller, state.generation);
        releaseBrowser(state);
        return state.generation;
      },
    );
    await this.check(authority);
    return this.host.invoke(
      {
        owner: authority.owner,
        controller: authority.controller,
        generation,
        operation: { command: "release" },
        policy: await authority.policy?.(authority.controller),
      },
      authority.signal,
    );
  }
  async status(authority: BrowserAuthority) {
    await this.check(authority);
    const state = await this.repository.read(authority.owner);
    const result = await this.host.invoke(
      {
        owner: authority.owner,
        controller: authority.controller,
        generation: state.generation,
        operation: { command: "status" },
        policy: await authority.policy?.(authority.controller),
      },
      authority.signal,
    );
    await this.check(authority);
    return {
      ...result,
      revision: state.revision,
      lease: state.lease,
      input:
        state.input &&
        (authority.controller.kind === "human" ||
          sameController(state.input.controller, authority.controller))
          ? {
              id: state.input.id,
              label: state.input.label,
              kind: state.input.kind,
              origin: state.input.origin,
              state: state.input.state,
              expiresAt: state.input.expiresAt,
            }
          : undefined,
    };
  }
  static humanController(): BrowserController {
    return { kind: "human", id: randomUUID(), fence: 0 };
  }
}
