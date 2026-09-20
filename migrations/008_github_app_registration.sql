CREATE TABLE github_apps (
  operator_id uuid PRIMARY KEY REFERENCES admins(id),
  credentials text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE github_app_flows (
  state_hash text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  admin_id uuid NOT NULL REFERENCES admins(id),
  session_hash text NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  organization text,
  phase text NOT NULL CHECK(phase IN ('pending','exchanging')),
  expires_at timestamptz NOT NULL,
  UNIQUE(admin_id,session_hash)
);
CREATE INDEX github_app_flows_expiry ON github_app_flows(expires_at);
