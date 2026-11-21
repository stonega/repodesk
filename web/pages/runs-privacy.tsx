import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ChevronLeft } from "reicon-react";
import { runMessageEntries } from "../../src/admin/run-statistics.ts";
import type {
  ThreadDetail,
  ThreadHistoryPage,
} from "../../src/admin/thread-history.ts";
import type { Delivery, Run } from "../../src/domain.ts";
import {
  Action,
  api,
  Field,
  Notice,
  Page,
  Pager,
  useData,
} from "../admin-shared.tsx";
import { DataDetails } from "../data-details.tsx";
import { chargeFields, deliveryFields, runFields } from "../form-fields.ts";
import { CreateModal } from "../modal.tsx";
import { RecordForm } from "../record-form.tsx";
import { RunAttempts } from "../run-attempts.tsx";
import { RunStatistics } from "../run-statistics.tsx";
import { Skeleton, SkeletonRows } from "../skeleton.tsx";
import { TelegramUserInfo, ThreadIdentity } from "../telegram-identity.tsx";
import { ApprovalList } from "./members-groups.tsx";

type AdminRun = Run & { deliveries: Delivery[] };

function RunMessages({ run }: { run: AdminRun }) {
  const entries = runMessageEntries(run);
  return (
    <section className="run-message-section" aria-label="Messages">
      <h2>Messages</h2>
      <ol className="run-messages">
        {entries.map((entry, index) => (
          // Checkpoints are an ordered, immutable snapshot and need not have IDs.
          // biome-ignore lint/suspicious/noArrayIndexKey: Ordered run transcript.
          <li key={index}>
            <strong>{entry.label}</strong>
            {entry.text && <p className="prose">{entry.text}</p>}
            {entry.calls.length > 0 && (
              <p className="muted">Called {entry.calls.join(", ")}</p>
            )}
            {!entry.text && entry.calls.length === 0 && (
              <p className="muted">No text content</p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ThreadsPage({ id }: { id: string }) {
  const [params] = useSearchParams();
  const rawOffset = Number(params.get("offset"));
  const offset =
    Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  return <ThreadListPage key={`${id}:${offset}`} id={id} offset={offset} />;
}
function ThreadListPage({ id, offset }: { id: string; offset: number }) {
  const { data, error, reload, loading } = useData<ThreadHistoryPage>(
    `/api/admin/workspaces/${id}/threads?offset=${offset}&limit=25`,
  );
  return (
    <Page
      title="Threads"
      description="Continuous conversations with your Telegram assistant. Open a thread to follow its requests and replies."
      actions={
        <>
          {data?.mode === "member" && (
            <CreateModal label="New request">
              {(close) => (
                <RecordForm
                  fields={runFields}
                  value={{
                    task: "Create a source-grounded team recap.",
                    chatId: "",
                    topicId: 0,
                  }}
                  label="Queue request"
                  save={async (value) => {
                    await api(
                      `/api/admin/workspaces/${id}/runs`,
                      "POST",
                      value,
                    );
                    close();
                    reload();
                  }}
                />
              )}
            </CreateModal>
          )}
          {error && (
            <Action loading={loading} onClick={async () => reload()}>
              Try again
            </Action>
          )}
        </>
      }
    >
      {error && <Notice error>{error}</Notice>}
      {!data && loading && (
        <section aria-label="Threads" aria-busy="true">
          <SkeletonRows label="Thread summaries" rows={3} />
        </section>
      )}
      {data?.total === 0 && (
        <section className="card">No conversations yet.</section>
      )}
      {data && data.total > 0 && data.items.length === 0 && (
        <section className="card">
          No threads on this page. Use Previous page to return to earlier
          conversations.
        </section>
      )}
      {data?.items.map((thread) => (
        <Link
          className="run-card thread-card"
          key={thread.id}
          to={`/admin/threads/${encodeURIComponent(thread.id)}?${new URLSearchParams({ workspace: id, listOffset: String(offset) })}`}
        >
          <span className="run-card-heading">
            <span className="run-card-title">{thread.title}</span>
            <span className="pill">{thread.status.replaceAll("_", " ")}</span>
          </span>
          <ThreadIdentity thread={thread} />
          {thread.preview && (
            <span className="thread-preview">{thread.preview}</span>
          )}
          <span className="run-card-line">
            {thread.requestCount}{" "}
            {thread.requestCount === 1 ? "request" : "requests"} · Updated{" "}
            {new Date(thread.updatedAt).toLocaleString()}
          </span>
        </Link>
      ))}
      <Pager data={data} pageSize={25} loading={loading} alwaysShow />
    </Page>
  );
}
export function ThreadDetailRoute({ id }: { id: string }) {
  const { threadId = "" } = useParams();
  const [params] = useSearchParams();
  const rawOffset = Number(params.get("offset"));
  const offset =
    Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  return (
    <ThreadDetailPage
      key={`${id}:${threadId}:${offset}`}
      id={id}
      threadId={threadId}
      offset={offset}
    />
  );
}
function ThreadDetailPage({
  id,
  threadId,
  offset,
}: {
  id: string;
  threadId: string;
  offset: number;
}) {
  const [params] = useSearchParams();
  const rawListOffset = Number(params.get("listOffset"));
  const listOffset =
    Number.isSafeInteger(rawListOffset) && rawListOffset > 0
      ? rawListOffset
      : 0;
  const { data, error, reload, loading } = useData<ThreadDetail>(
    `/api/admin/workspaces/${id}/threads/${encodeURIComponent(threadId)}?offset=${offset}&limit=25`,
  );
  return (
    <>
      <p>
        <Link
          className="page-back-link"
          to={`/admin/threads?${new URLSearchParams({ workspace: id, offset: String(listOffset) })}`}
        >
          <ChevronLeft
            size={18}
            weight="Outline"
            color="currentColor"
            aria-hidden="true"
          />
          Back to Threads
        </Link>
      </p>
      <Page
        title={data?.thread.title ?? "Thread"}
        titleBadge={data?.thread.status.replaceAll("_", " ")}
        actions={
          error && (
            <Action loading={loading} onClick={async () => reload()}>
              Try again
            </Action>
          )
        }
      >
        <section
          className="card"
          aria-label="Telegram conversation"
          aria-busy={loading}
        >
          <h2>Telegram conversation</h2>
          {data ? (
            <>
              <ThreadIdentity thread={data.thread} linked />
              <p className="muted">
                {data.total} {data.total === 1 ? "request" : "requests"} ·
                Updated {new Date(data.thread.updatedAt).toLocaleString()}
              </p>
            </>
          ) : loading ? (
            <SkeletonRows label="Telegram identity" rows={2} />
          ) : (
            <p className="muted">Conversation information unavailable.</p>
          )}
        </section>
        <RunStatistics
          statistics={data?.statistics}
          conversation
          loading={loading}
        />
        {error && (
          <Notice error>
            {error === "not_found"
              ? "This thread is unavailable in this workspace. It may have expired or been removed."
              : error}
          </Notice>
        )}
        {!data && loading && (
          <section className="card" aria-label="Conversation" aria-busy="true">
            <h2>Conversation</h2>
            <SkeletonRows label="Conversation messages" rows={3} />
          </section>
        )}
        {data && (
          <section
            className="card"
            aria-label="Conversation"
            aria-busy={loading}
          >
            <h2>Conversation</h2>
            {data.items.length === 0 && (
              <p className="muted">
                No requests on this page. Use Previous page to return to earlier
                messages.
              </p>
            )}
            <ol className="thread-conversation" start={offset + 1}>
              {data.items.map((turn) => (
                <li className="thread-conversation-turn" key={turn.id}>
                  <article
                    className="thread-turn"
                    aria-label={`Request from ${turn.user.name || turn.user.username || turn.user.id}`}
                  >
                    <div className="thread-turn-heading">
                      <TelegramUserInfo user={turn.user} linked />
                      <time className="muted" dateTime={turn.at}>
                        {new Date(turn.at).toLocaleString()}
                      </time>
                    </div>
                    <p className="prose">{turn.task}</p>
                    <div className="thread-reply">
                      <strong>Telo</strong>
                      {turn.result ? (
                        <p className="prose">{turn.result}</p>
                      ) : (
                        <p className="muted">
                          {turn.status === "queued"
                            ? "Queued for a reply."
                            : turn.status === "running"
                              ? "Working on a reply…"
                              : turn.status === "awaiting_approval"
                                ? "Waiting for approval."
                                : "No assistant reply recorded."}
                        </p>
                      )}
                    </div>
                    <div className="thread-turn-footer">
                      <span className="pill">
                        {turn.status.replaceAll("_", " ")}
                      </span>
                      <Link
                        to={`/admin/runs/${turn.id}?${new URLSearchParams({ workspace: id, thread: threadId, threadOffset: String(offset), listOffset: String(listOffset) })}`}
                      >
                        Run details
                      </Link>
                    </div>
                  </article>
                </li>
              ))}
            </ol>
          </section>
        )}
        <Pager data={data} pageSize={25} loading={loading} alwaysShow />
      </Page>
    </>
  );
}
export function RunDetailRoute({ id }: { id: string }) {
  const { runId = "" } = useParams();
  return <RunDetailPage key={`${id}:${runId}`} id={id} runId={runId} />;
}
function RunDetailPage({ id, runId }: { id: string; runId: string }) {
  const [params] = useSearchParams();
  const backParams = new URLSearchParams(params);
  backParams.set("workspace", id);
  const { data, error, reload, loading } = useData<{
    mode: "member" | "operator";
    threadId?: string;
    run: AdminRun;
  }>(`/api/admin/workspaces/${id}/runs/${encodeURIComponent(runId)}`);
  const run = data?.run;
  const threadId = data?.threadId ?? params.get("thread");
  const threadParams = new URLSearchParams({
    workspace: id,
    offset: params.get("threadOffset") ?? "0",
    listOffset: params.get("listOffset") ?? params.get("offset") ?? "0",
  });
  return (
    <>
      <p>
        <Link
          className="page-back-link"
          to={
            threadId
              ? `/admin/threads/${encodeURIComponent(threadId)}?${threadParams.toString()}`
              : `/admin/threads?${backParams.toString()}`
          }
        >
          <ChevronLeft
            size={18}
            weight="Outline"
            color="currentColor"
            aria-hidden="true"
          />
          {threadId ? "Back to thread" : "Back to Threads"}
        </Link>
      </p>
      <Page
        title={`Run ${runId.slice(0, 8)}`}
        titleBadge={run?.status}
        actions={
          error && (
            <Action loading={loading} onClick={async () => reload()}>
              Try again
            </Action>
          )
        }
      >
        <RunStatistics run={run} loading={loading} />
        {error && (
          <Notice error>
            {error === "not_found"
              ? "This run is unavailable in this workspace. It may have expired or been removed."
              : error}
          </Notice>
        )}
        {!run && loading && (
          <section className="card" aria-label="Run details" aria-busy="true">
            <Skeleton width="65%" />
            <h2>Messages</h2>
            <SkeletonRows label="Run messages" rows={3} />
          </section>
        )}
        {run && data && (
          <section
            className="card"
            aria-label="Run details"
            aria-busy={loading}
          >
            <p className="mono run-id">{run.id}</p>
            <p className="muted">
              {new Date(run.at).toLocaleString()} · Actor {run.actor} ·{" "}
              {run.model} · Settings v{run.settingsVersion}
              {run.workflowVersion && ` · Workflow v${run.workflowVersion}`}
            </p>
            {run.error && <Notice error>{run.error}</Notice>}
            <RunMessages run={run} />
            {run.coverage && <p className="muted">{run.coverage}</p>}
            <details>
              <summary>Versions, usage, checkpoints & delivery</summary>
              <DataDetails
                value={{
                  skillPins: run.skillPins,
                  instructions: run.instructions.map((i) => ({
                    id: i.id,
                    version: i.version,
                  })),
                }}
              />
              <RunAttempts attempts={run.attempts} />
              <DataDetails
                value={{
                  transcript: run.transcript,
                  deliveries: run.deliveries,
                }}
              />
            </details>
            {data.mode === "member" && (
              <>
                <RunRecovery id={id} run={run} reload={reload} />
                <div className="row">
                  <Action
                    icon="stop"
                    onClick={async () => {
                      await api(
                        `/api/admin/workspaces/${id}/runs/${run.id}/cancel`,
                        "POST",
                        {},
                      );
                      reload();
                    }}
                  >
                    Cancel
                  </Action>
                  {["failed", "partial", "cancelled"].includes(run.status) && (
                    <Action
                      onClick={async () => {
                        await api(
                          `/api/admin/workspaces/${id}/runs/${run.id}/retry`,
                          "POST",
                          {},
                        );
                        reload();
                      }}
                    >
                      Create retry (new budget)
                    </Action>
                  )}
                </div>
              </>
            )}
          </section>
        )}
      </Page>
    </>
  );
}
function RunRecovery({
  id,
  run,
  reload,
}: {
  id: string;
  run: Run & { deliveries: Delivery[] };
  reload: () => void;
}) {
  return (
    <>
      {run.attempts
        .filter((a) => a.status === "unknown")
        .map((a) => (
          <details key={a.id}>
            <summary>Reconcile unknown charge {a.id}</summary>
            <p>
              Inspect the provider billing record first. This releases the
              reservation using the actual charge you enter.
            </p>
            <RecordForm
              fields={chargeFields}
              value={{ attemptId: a.id, actualUsd: a.reserved, reference: "" }}
              label="Record verified charge"
              save={async (value) => {
                await api(
                  `/api/admin/workspaces/${id}/runs/${run.id}/reconcile`,
                  "POST",
                  value,
                );
                reload();
              }}
            />
          </details>
        ))}
      {run.deliveries
        .filter((d) => d.state === "delivery_unknown")
        .map((d) => (
          <details key={d.id}>
            <summary>Resolve unknown delivery {d.id}</summary>
            <p>
              Inspect Telegram first. Confirm the remote message ID, or abandon
              this delivery. Neither action resends it.
            </p>
            <RecordForm
              fields={deliveryFields}
              value={{ action: "confirm_sent", remoteId: 0 }}
              label="Resolve observed outcome"
              save={async (value) => {
                await api(
                  `/api/admin/workspaces/${id}/deliveries/${d.id}/resolve`,
                  "POST",
                  value,
                );
                reload();
              }}
            />
            <Action
              onClick={async () => {
                await api(
                  `/api/admin/workspaces/${id}/deliveries/${d.id}/resolve`,
                  "POST",
                  { action: "abandon" },
                );
                reload();
              }}
            >
              Abandon without resend
            </Action>
          </details>
        ))}
    </>
  );
}
export function PrivacyPage({ id }: { id: string }) {
  const { data, error, reload } = useData<
    | { status: "not_requested"; retentionDays: number }
    | { requestedAt: string; purgedAt?: string; providerState: string }
  >(`/api/admin/workspaces/${id}/deletion`);
  const [confirm, setConfirm] = useState("");
  return (
    <Page
      title="Privacy & removal"
      description="Deletion revokes access immediately, cancels pending work, and purges stored content on the worker sweep."
    >
      {error && <Notice error>{error}</Notice>}
      <section className="card">
        {data ? (
          <>
            <p>
              <strong>Workspace removal: </strong>
              {"status" in data
                ? "No deletion requested."
                : data.purgedAt
                  ? "Stored content removed."
                  : "Deletion in progress."}
            </p>
            {"retentionDays" in data ? (
              <p>
                <strong>Message retention: </strong>
                {data.retentionDays} {data.retentionDays === 1 ? "day" : "days"}
                .
              </p>
            ) : (
              <p>
                <strong>{data.purgedAt ? "Removed: " : "Requested: "}</strong>
                {new Date(data.purgedAt ?? data.requestedAt).toLocaleString()}
              </p>
            )}
          </>
        ) : !error ? (
          <dl className="plugin-summary" aria-busy="true">
            <div>
              <dt>Workspace removal</dt>
              <dd>
                <Skeleton width="12rem" />
              </dd>
            </div>
            <div>
              <dt>Message retention</dt>
              <dd>
                <Skeleton width="6rem" />
              </dd>
            </div>
          </dl>
        ) : null}
        <p>
          No provider-hosted sessions are created. API providers may retain
          request data according to your account policy; this application cannot
          erase those records.
        </p>
        <Field label="Type DELETE to request complete workspace removal">
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        {confirm === "DELETE" && (
          <Action
            danger
            onClick={async () => {
              await api(`/api/admin/workspaces/${id}/deletion`, "POST", {});
              reload();
            }}
          >
            Request deletion approval
          </Action>
        )}
      </section>
      <ApprovalList id={id} reloadParent={reload} refreshKey={data} />
    </Page>
  );
}
