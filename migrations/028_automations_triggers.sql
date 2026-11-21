-- Deduplication and cooldown ledger for event-triggered automations and silent watchers.
CREATE TABLE IF NOT EXISTS workspace_automation_events (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  workflow_id text NOT NULL,
  event_key text NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_automation_events_dedupe
  ON workspace_automation_events(workspace_id, workflow_id, event_key);

CREATE INDEX IF NOT EXISTS workspace_automation_events_cooldown
  ON workspace_automation_events(workspace_id, workflow_id, kind, created_at DESC);
