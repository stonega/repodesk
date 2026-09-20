CREATE TABLE github_flows (
  state_hash text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  admin_id uuid NOT NULL REFERENCES admins(id),
  session_hash text NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  verifier text NOT NULL,
  phase text NOT NULL CHECK(phase IN ('oauth','exchanging','selecting')),
  user_token text,
  login text,
  expires_at timestamptz NOT NULL,
  UNIQUE(workspace_id,admin_id,session_hash)
);
CREATE INDEX github_flows_expiry ON github_flows(expires_at);
