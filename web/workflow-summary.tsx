import type { WorkflowMetadata } from "../src/admin/workflow-view.ts";

export function scheduleLabel(recurrence: WorkflowMetadata["recurrence"]) {
  const day = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const frequency =
    recurrence.frequency === "weekly"
      ? `Every ${day[(recurrence.weekday ?? 7) % 7]}`
      : "Every day";
  return `${frequency} at ${String(recurrence.hour).padStart(2, "0")}:${String(recurrence.minute).padStart(2, "0")}`;
}

function ScheduleTime({ at, timezone }: { at: string; timezone: string }) {
  return (
    <time dateTime={at} title={at}>
      {new Intl.DateTimeFormat("en", {
        timeZone: timezone,
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(at))}
    </time>
  );
}

export function WorkflowSummary({
  workflow: f,
  detail = false,
}: {
  workflow: WorkflowMetadata;
  detail?: boolean;
}) {
  return (
    <>
      <dl className="workflow-summary">
        <div>
          <dt>Schedule</dt>
          <dd>
            {scheduleLabel(f.recurrence)}
            <small>{f.recurrence.timezone}</small>
          </dd>
        </div>
        <div>
          <dt>
            {f.status === "active" ? "Next scheduled time" : "Schedule preview"}
          </dt>
          <dd>
            {f.next[0] ? (
              <ScheduleTime at={f.next[0]} timezone={f.recurrence.timezone} />
            ) : (
              "No upcoming time"
            )}
            {f.status !== "active" && (
              <small>Not scheduled while {f.status}</small>
            )}
          </dd>
        </div>
        <div>
          <dt>Budget per run</dt>
          <dd>
            {new Intl.NumberFormat("en", {
              style: "currency",
              currency: "USD",
              maximumFractionDigits: 3,
            }).format(f.budgetUsd)}
          </dd>
        </div>
      </dl>
      {detail && (
        <>
          <h3>Upcoming schedule times</h3>
          <p className="muted">
            Times are shown in {f.recurrence.timezone}. These are recurrence
            previews; execution depends on workflow and workspace availability.
          </p>
          {f.next.length ? (
            <ul className="workflow-times">
              {f.next.map((at) => (
                <li key={at}>
                  <ScheduleTime at={at} timezone={f.recurrence.timezone} />
                </li>
              ))}
            </ul>
          ) : (
            <p>No upcoming time.</p>
          )}
          <dl className="workflow-summary">
            <div>
              <dt>Owner (Telegram ID)</dt>
              <dd>{f.owner}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{f.version}</dd>
            </div>
            <div>
              <dt>Workflow ID</dt>
              <dd className="mono">{f.id}</dd>
            </div>
          </dl>
        </>
      )}
      {f.reason && <p className="notice">{f.reason}</p>}
    </>
  );
}
