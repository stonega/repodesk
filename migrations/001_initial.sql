CREATE TABLE deployment (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  claimed boolean NOT NULL DEFAULT false,
  bootstrap_hash text, bootstrap_expires_at timestamptz,
  data jsonb NOT NULL DEFAULT '{"version":1,"active":false,"model":"gpt-4.1-mini","credentials":{},"webhookReady":false,"ownerVerified":false,"paused":false}'
);
INSERT INTO deployment(id) VALUES(true);
CREATE TABLE admins (
  id uuid PRIMARY KEY, username text NOT NULL UNIQUE, password_hash text NOT NULL,
  telegram_id text UNIQUE, operator boolean NOT NULL DEFAULT false
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY, admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE auth_limits (key text PRIMARY KEY, attempts int NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE workspaces (
  id uuid PRIMARY KEY, operator_id uuid NOT NULL REFERENCES admins(id),
  data jsonb NOT NULL CHECK(data->>'id' = id::text), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE chat_bindings (
  chat_id text PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id),
  UNIQUE(workspace_id)
);
CREATE TABLE inbox (
  bot_id text NOT NULL, update_id bigint NOT NULL, workspace_id uuid REFERENCES workspaces(id),
  accepted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(bot_id,update_id)
);
CREATE TABLE outbox (
  id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('run','delivery')),
  workspace_id uuid NOT NULL REFERENCES workspaces(id), target_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz,
  UNIQUE(kind,workspace_id,target_id)
);
CREATE INDEX outbox_pending ON outbox(created_at) WHERE dispatched_at IS NULL;
CREATE TABLE worker_heartbeats (id text PRIMARY KEY, at timestamptz NOT NULL);
CREATE TABLE operator_audit (id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL, target text NOT NULL, at timestamptz NOT NULL DEFAULT now());
