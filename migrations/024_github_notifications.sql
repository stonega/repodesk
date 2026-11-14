CREATE TABLE github_notification_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id bigint NOT NULL,
  delivery_id text NOT NULL,
  event_key text NOT NULL,
  payload jsonb,
  recipients jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE(workspace_id,app_id,delivery_id),
  UNIQUE(workspace_id,app_id,event_key)
);
CREATE INDEX github_notification_pending ON github_notification_events(workspace_id,created_at) WHERE processed_at IS NULL;
CREATE TABLE github_webhook_recovery (
  operator_id uuid PRIMARY KEY REFERENCES admins(id) ON DELETE CASCADE,
  app_id bigint NOT NULL,
  next_at timestamptz NOT NULL DEFAULT now(),
  cursor text,
  attempts jsonb NOT NULL DEFAULT '{}'::jsonb
);
