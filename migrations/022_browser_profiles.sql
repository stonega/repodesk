-- Browser coordination is private to a verified tenant/user. Never store raw
-- passwords, page extracts or screenshots in workspace configuration JSON.
CREATE TABLE browser_profiles (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor text NOT NULL CHECK (actor ~ '^[1-9][0-9]{0,15}$'),
  data text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, actor)
);
