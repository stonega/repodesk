CREATE TABLE github_user_flows (
  state_hash text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor text NOT NULL,
  bot_id text NOT NULL,
  app_id bigint NOT NULL,
  connection_revision integer NOT NULL,
  verifier text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('oauth','exchanging','confirm')),
  identity jsonb,
  user_token text,
  refresh_token text,
  token_expires_at timestamptz,
  expires_at timestamptz NOT NULL,
  UNIQUE(workspace_id,actor)
);
CREATE TABLE github_user_accounts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor text NOT NULL,
  github_id bigint NOT NULL,
  app_id bigint NOT NULL,
  user_token text NOT NULL,
  refresh_token text,
  token_expires_at timestamptz,
  next_sync_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,actor),
  UNIQUE(workspace_id,github_id)
);
CREATE INDEX github_user_sync_due ON github_user_accounts(next_sync_at);
